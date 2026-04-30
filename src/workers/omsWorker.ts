/**
 * THREAD C — OMS (Order Management System)
 *
 * Improvements over v1:
 *  - Trailing stop: once profit > 1×ATR, stop moves to breakeven
 *  - Compound sizing: position size = (balance * riskPct) / stopDistance
 *  - Signal staleness: rejects signals older than 3 seconds
 *  - Cleaner strict-TS compliance (no unused vars)
 */

import { workerData, parentPort } from 'worker_threads';
import type { MessagePort } from 'worker_threads';
import { createHmac, createHash } from 'crypto';
import https from 'https';
import { BID_PRICE, ASK_PRICE } from '../shared/sharedBuffer.js';
import { CircuitBreaker, SystemState } from '../engine/SafetyManager.js';

const {
  sharedBuffer,
  omsPort,       // ← MessagePort from Engine (Thread B) — this is where signals arrive
  apiKey, apiSecret,
  symbol, dryRun,
  maxDailyLossRate, accountBalance,
  stopAtrMult, makerFee,
  riskPerTrade,
} = workerData as {
  sharedBuffer: SharedArrayBuffer;
  omsPort: MessagePort;
  apiKey: string;
  apiSecret: string;
  symbol: string;
  dryRun: boolean;
  maxDailyLossRate: number;
  accountBalance: number;
  stopAtrMult: number;
  makerFee: number;
  riskPerTrade: number;
};

const data = new Float64Array(sharedBuffer);

// ── State ─────────────────────────────────────────────────────────────────────
let _position: 'long' | 'short' | 'flat' = 'flat';
let _entryPrice   = 0;
let _stopPrice    = 0;
let _targetPrice  = 0;
let _tradeAtr     = 0;   // ATR at entry, used for trailing stop calc
let _tradeQty     = 0;   // actual quantity for this trade
let _trailingActive = false;
let _peakPriceSinceEntry = 0; // for trailing stop tracking

let _dailyPnl  = 0;
let _totalPnl  = 0;
let _currentBalance = accountBalance;
let _wins   = 0;
let _losses = 0;
let _halted = false;
let _paused = false; // controlled by dashboard Start/Stop buttons
let _entryTimestamp = 0;  // for 24h max hold enforcement
const MAX_HOLD_MS = 24 * 60 * 60_000; // force-close after 24 hours

// ── Daily PnL reset at UTC midnight ──────────────────────────────────────────
function scheduleMidnightReset(): void {
  const now = new Date();
  const msUntilMidnight =
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).getTime() - Date.now();
  setTimeout(() => {
    _dailyPnl = 0;
    _halted   = false; // un-halt daily loss circuit breaker at day start
    parentPort?.postMessage({ type: 'status', msg: '🌅 New trading day — daily P&L reset.' });
    scheduleMidnightReset();
  }, msUntilMidnight);
}

const _breaker = new CircuitBreaker(
  (workerData.maxDrawdownUsd as number | undefined) ?? 500
);

const SIGNAL_MAX_AGE_MS = 3_000; // reject signals older than 3 seconds

// ── Compound position sizing ──────────────────────────────────────────────────
// Risk a fixed % of current balance per trade.
// positionSize (BTC) = (balance * riskPct) / (stopDistance in USD)
function calcPositionSize(price: number, atr: number): number {
  const stopDistanceUsd = atr * stopAtrMult;
  if (stopDistanceUsd <= 0) return 0.001;
  const rawSize = (_currentBalance * riskPerTrade) / stopDistanceUsd;
  // Cap at 20% of balance to prevent over-exposure on meme coins
  const maxSize = (_currentBalance * 0.20) / price;
  return parseFloat(Math.min(rawSize, maxSize).toFixed(8));
}

// ── Kraken REST signing ───────────────────────────────────────────────────────
function sign(path: string, nonce: number, postData: string): string {
  const secret = Buffer.from(apiSecret, 'base64');
  const hash   = createHash('sha256').update(String(nonce) + postData).digest();
  const msg    = Buffer.concat([Buffer.from(path), hash]);
  return createHmac('sha512', secret).update(msg).digest('base64');
}

function krakenPost(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const nonce    = Date.now() * 1000;
    const postData = new URLSearchParams({ nonce: String(nonce), ...params }).toString();
    const sig      = sign(path, nonce, postData);

    const options = {
      hostname: 'api.kraken.com',
      path,
      method: 'POST',
      headers: {
        'API-Key':       apiKey,
        'API-Sign':      sig,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body) as Record<string, unknown>); }
        catch { reject(new Error(body)); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function placeLimitOrder(
  side: 'buy' | 'sell',
  price: number,
  qty: number,
  postOnly = false,   // ← true for exits (maker rebate), false for aggressive entries
): Promise<string | null> {
  if (dryRun) {
    const id = `DRY-${Date.now()}-${side}`;
    parentPort?.postMessage({ type: 'order', msg: `[DRY RUN] ${side.toUpperCase()} ${qty} @ ${price.toFixed(6)} → ${id}` });
    return id;
  }
  try {
    const orderParams: Record<string, string> = {
      ordertype: 'limit',
      type:      side,
      volume:    String(qty),
      price:     price.toFixed(6),
      pair:      symbol.replace('/', ''),
    };
    // Only use post-only (maker) flag on exit orders — entry must fill immediately
    if (postOnly) orderParams['oflags'] = 'post';

    const result = await krakenPost('/0/private/AddOrder', orderParams);
    const errors = result['error'] as string[] | undefined;
    if (errors?.length) throw new Error(errors.join(', '));
    const txid = (result['result'] as Record<string, string[]> | undefined)?.['txid']?.[0] ?? null;
    parentPort?.postMessage({ type: 'order', msg: `${side.toUpperCase()} ${qty} @ ${price.toFixed(6)} → ${txid}` });
    return txid;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ type: 'error', msg: `Order failed: ${msg}` });
    return null;
  }
}

// ── Signal handler ────────────────────────────────────────────────────────────
async function onSignal(msg: {
  signal: 1 | -1;
  price: number;
  atr: number;
  stop: number;
  target: number;
  timestamp: number;
}): Promise<void> {
  if (_halted) { parentPort?.postMessage({ type: 'status', msg: 'Signal ignored — bot halted.' }); return; }
  if (_paused) { parentPort?.postMessage({ type: 'status', msg: 'Signal ignored — bot paused by user.' }); return; }
  if (_position !== 'flat') { parentPort?.postMessage({ type: 'status', msg: 'Signal ignored — position open.' }); return; }

  // Reject stale signals
  if (Date.now() - msg.timestamp > SIGNAL_MAX_AGE_MS) {
    parentPort?.postMessage({ type: 'status', msg: `Signal rejected — ${Date.now() - msg.timestamp}ms stale` });
    return;
  }

  // Daily loss check
  if (_dailyPnl / accountBalance <= -maxDailyLossRate) {
    _halted = true;
    parentPort?.postMessage({ type: 'halt', msg: `Daily loss limit hit ($${_dailyPnl.toFixed(2)}). Halted.` });
    return;
  }

  const side = msg.signal === 1 ? 'buy' : 'sell';
  // Aggressive Limit: place order 0.1% past the current price to ensure immediate fill during breakout
  const entryPrice = msg.signal === 1
    ? msg.price * (1 + 0.001)
    : msg.price * (1 - 0.001);

  // Compound position sizing
  const qty = calcPositionSize(entryPrice, msg.atr);

  const txid = await placeLimitOrder(side, entryPrice, qty);
  if (!txid) return;

  _position           = msg.signal === 1 ? 'long' : 'short';
  _entryPrice         = entryPrice;
  _entryTimestamp     = Date.now();
  _stopPrice          = msg.stop;
  _targetPrice        = msg.target;
  _tradeAtr           = msg.atr;
  _tradeQty           = qty;
  _trailingActive     = false;
  _peakPriceSinceEntry = entryPrice;

  parentPort?.postMessage({
    type: 'status',
    msg: `OPEN ${_position.toUpperCase()} ${qty} BTC @ ${entryPrice.toFixed(2)} | Stop: ${_stopPrice.toFixed(2)} | Target: ${_targetPrice.toFixed(2)} | Risk: $${(qty * msg.atr * stopAtrMult).toFixed(2)}`,
  });
}

// ── Position monitor with trailing stop ───────────────────────────────────────
async function monitorPosition(): Promise<void> {
  if (_position === 'flat' || _halted) return;

  const bid = Atomics.load(data, BID_PRICE);
  const ask = Atomics.load(data, ASK_PRICE);
  if (bid === 0 || ask === 0) return;

  const currentPrice = _position === 'long' ? bid : ask;

  // ── Trailing stop logic ────────────────────────────────────────────────────
  if (_position === 'long') {
    if (currentPrice > _peakPriceSinceEntry) _peakPriceSinceEntry = currentPrice;

    // Activate trailing once we're 1×ATR in profit
    if (!_trailingActive && currentPrice >= _entryPrice + _tradeAtr) {
      _trailingActive = true;
      _stopPrice = _entryPrice; // move stop to breakeven
      parentPort?.postMessage({ type: 'status', msg: `Trailing stop activated — stop moved to breakeven ${_stopPrice.toFixed(2)}` });
    }
    // Keep trailing stop tighter (0.5×ATR) below the peak once in profit
    if (_trailingActive) {
      const trailStop = _peakPriceSinceEntry - (_tradeAtr * 0.5);
      if (trailStop > _stopPrice) _stopPrice = trailStop;
    }
  } else {
    if (currentPrice < _peakPriceSinceEntry) _peakPriceSinceEntry = currentPrice;

    if (!_trailingActive && currentPrice <= _entryPrice - _tradeAtr) {
      _trailingActive = true;
      _stopPrice = _entryPrice;
      parentPort?.postMessage({ type: 'status', msg: `Trailing stop activated — stop moved to breakeven ${_stopPrice.toFixed(2)}` });
    }
    if (_trailingActive) {
      const trailStop = _peakPriceSinceEntry + (_tradeAtr * 0.5);
      if (trailStop < _stopPrice) _stopPrice = trailStop;
    }
  }

  // ── Check exit conditions ──────────────────────────────────────────────────
  const hitTarget  = _position === 'long' ? currentPrice >= _targetPrice : currentPrice <= _targetPrice;
  const hitStop    = _position === 'long' ? currentPrice <= _stopPrice   : currentPrice >= _stopPrice;
  const hitMaxHold = (Date.now() - _entryTimestamp) >= MAX_HOLD_MS;

  if (!hitTarget && !hitStop && !hitMaxHold) return;

  if (hitMaxHold && !hitTarget && !hitStop) {
    parentPort?.postMessage({ type: 'status', msg: `⏰ 24h max hold reached — force-closing position` });
  }

  const exitSide  = _position === 'long' ? 'sell' : 'buy';
  const exitPrice = hitTarget ? _targetPrice : _stopPrice;

  // Use post-only (maker) flag on exits to save fees; aggressive fill on entry only
  await placeLimitOrder(exitSide, exitPrice, _tradeQty, true);

  const rawPnl = _position === 'long'
    ? (exitPrice - _entryPrice) * _tradeQty
    : (_entryPrice - exitPrice) * _tradeQty;
  const fees   = (exitPrice * _tradeQty * makerFee) + (_entryPrice * _tradeQty * makerFee);
  const netPnl = rawPnl - fees;

  _dailyPnl += netPnl;
  _totalPnl += netPnl;
  _currentBalance += netPnl; // compound the account
  if (netPnl >= 0) _wins++; else _losses++;

  const winRate = _wins + _losses > 0 ? ((_wins / (_wins + _losses)) * 100).toFixed(1) : 'N/A';

  parentPort?.postMessage({
    type: 'fill',
    msg: `${hitTarget ? '✅ TARGET' : '🛑 STOP'} | ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(4)} | Total: $${_totalPnl.toFixed(4)} | W/L: ${_wins}/${_losses} (${winRate}%) | Balance: $${_currentBalance.toFixed(2)}`,
    pnl: netPnl, totalPnl: _totalPnl, wins: _wins, losses: _losses, balance: _currentBalance,
  });

  // Safety check
  const state = _breaker.checkHealth(_totalPnl);
  if (state === SystemState.EMERGENCY_STOP) {
    _halted = true;
    parentPort?.postMessage({
      type: 'halt',
      msg: `🚨 CIRCUIT BREAKER — Drawdown $${_breaker.getDrawdown(_totalPnl).toFixed(2)} hit limit.`,
    });
  } else if (state === SystemState.WARNING) {
    parentPort?.postMessage({
      type: 'warning',
      msg: `⚠️ WARNING — Drawdown $${_breaker.getDrawdown(_totalPnl).toFixed(2)} at 50%+ of limit.`,
    });
  }

  // Reset position state
  _position           = 'flat';
  _entryPrice         = 0;
  _stopPrice          = 0;
  _targetPrice        = 0;
  _tradeAtr           = 0;
  _tradeQty           = 0;
  _trailingActive     = false;
  _peakPriceSinceEntry = 0;
}

// ── Incoming signals from Engine (Thread B) via MessagePort ───────────────────
omsPort.on('message', (msg: unknown) => {
  const m = msg as { signal?: number; price?: number; atr?: number; stop?: number; target?: number; timestamp?: number };
  if (typeof m?.signal === 'number') {
    void onSignal(m as Parameters<typeof onSignal>[0]);
  }
});

// ── Pause / Resume commands from main thread (dashboard buttons) ──────────────
parentPort?.on('message', (msg: unknown) => {
  const m = msg as { cmd?: string };
  if (m?.cmd === 'pause')  { _paused = true;  parentPort?.postMessage({ type: 'status', msg: '⏸ Bot paused — no new trades.' }); }
  if (m?.cmd === 'resume') { _paused = false; parentPort?.postMessage({ type: 'status', msg: '▶ Bot resumed — scanning for signals.' }); }
});

// ── Monitor loop (every 100ms for faster stop detection) ─────────────────────
setInterval(() => { void monitorPosition(); }, 100);

scheduleMidnightReset();
parentPort?.postMessage({ type: 'status', msg: `OMS ready | DryRun: ${dryRun} | Balance: $${accountBalance}` });
