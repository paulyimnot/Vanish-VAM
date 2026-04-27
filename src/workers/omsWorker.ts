/**
 * THREAD C — OMS (Order Management System)
 *
 * Receives signal from Thread B via MessagePort.
 * Places limit orders on Kraken REST API v2.
 * Manages stop loss and take profit monitoring.
 * Reports fills and P&L to main thread.
 *
 * Uses Kraken REST API v2 with HMAC-SHA512 signing (Node crypto built-in).
 */

import { workerData, parentPort, MessagePort } from 'worker_threads';
import { createHmac, createHash } from 'crypto';
import https from 'https';
import { Atomics as _Atomics } from 'atomics';
import { BID_PRICE, ASK_PRICE } from '../shared/sharedBuffer.js';
import { CircuitBreaker, SystemState } from '../engine/SafetyManager.js';

const {
  sharedBuffer,
  apiKey, apiSecret,
  symbol, orderAmount, dryRun,
  maxDailyLossRate, accountBalance,
} = workerData as {
  sharedBuffer: SharedArrayBuffer;
  apiKey: string;
  apiSecret: string;
  symbol: string;
  orderAmount: number;
  dryRun: boolean;
  maxDailyLossRate: number;
  accountBalance: number;
};

const data = new Float64Array(sharedBuffer);

// ── State ─────────────────────────────────────────────────────────────────────
let _position: 'long' | 'short' | 'flat' = 'flat';
let _entryPrice = 0;
let _stopPrice  = 0;
let _targetPrice = 0;
let _entryOrderId = '';
let _dailyPnl = 0;
let _totalPnl = 0;
let _wins = 0;
let _losses = 0;
let _halted = false;

const _breaker = new CircuitBreaker(
  workerData.maxDrawdownUsd as number ?? 500
);

// ── Kraken REST signing ───────────────────────────────────────────────────────
function sign(path: string, nonce: number, postData: string): string {
  const secret = Buffer.from(apiSecret, 'base64');
  const hash   = createHash('sha256').update(nonce + postData).digest();
  const msg    = Buffer.concat([Buffer.from(path), hash]);
  return createHmac('sha512', secret).update(msg).digest('base64');
}

function krakenPost(path: string, params: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const nonce = Date.now() * 1000;
    const postData = new URLSearchParams({ nonce: String(nonce), ...params }).toString();
    const sig = sign(path, nonce, postData);

    const options = {
      hostname: 'api.kraken.com',
      path,
      method: 'POST',
      headers: {
        'API-Key':  apiKey,
        'API-Sign': sig,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error(body)); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function placeLimitOrder(side: 'buy' | 'sell', price: number, qty: number): Promise<string | null> {
  if (dryRun) {
    const id = `DRY-${Date.now()}-${side}`;
    parentPort?.postMessage({ type: 'order', msg: `[DRY RUN] ${side.toUpperCase()} ${qty} @ ${price} → ${id}` });
    return id;
  }
  try {
    const result = await krakenPost('/0/private/AddOrder', {
      ordertype: 'limit',
      type:      side,
      volume:    String(qty),
      price:     String(price),
      pair:      symbol.replace('/', ''),
      oflags:    'post', // maker-only (post-only): reject if would be taker
    });
    if (result.error?.length) throw new Error(result.error.join(', '));
    const txid = result.result?.txid?.[0] ?? null;
    parentPort?.postMessage({ type: 'order', msg: `${side.toUpperCase()} ${qty} @ ${price} → ${txid}` });
    return txid;
  } catch (err: any) {
    parentPort?.postMessage({ type: 'error', msg: `Order failed: ${err.message}` });
    return null;
  }
}

async function cancelOrder(txid: string): Promise<void> {
  if (dryRun) return;
  try {
    await krakenPost('/0/private/CancelOrder', { txid });
  } catch { /* best effort */ }
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
  if (_halted) {
    parentPort?.postMessage({ type: 'status', msg: 'Signal ignored — bot halted.' });
    return;
  }
  if (_position !== 'flat') {
    parentPort?.postMessage({ type: 'status', msg: 'Signal ignored — position open.' });
    return;
  }

  // Check daily loss limit
  if (_dailyPnl / accountBalance <= -maxDailyLossRate) {
    _halted = true;
    parentPort?.postMessage({ type: 'halt', msg: `Daily loss limit hit (${(_dailyPnl).toFixed(2)} USD). Halted.` });
    return;
  }

  const side = msg.signal === 1 ? 'buy' : 'sell';
  const entryPrice = msg.signal === 1
    ? msg.price * (1 - 0.0005)  // 0.05% below mid for limit buy (inside spread)
    : msg.price * (1 + 0.0005); // 0.05% above mid for limit sell

  const txid = await placeLimitOrder(side, entryPrice, orderAmount);
  if (!txid) return;

  _position    = msg.signal === 1 ? 'long' : 'short';
  _entryPrice  = entryPrice;
  _stopPrice   = msg.stop;
  _targetPrice = msg.target;
  _entryOrderId = txid;

  parentPort?.postMessage({
    type: 'status',
    msg: `Position OPEN: ${_position} @ ${entryPrice} | Stop: ${_stopPrice.toFixed(2)} | Target: ${_targetPrice.toFixed(2)}`,
  });
}

// ── Position monitor ──────────────────────────────────────────────────────────
async function monitorPosition(): Promise<void> {
  if (_position === 'flat' || _halted) return;

  const bid = Atomics.load(data, BID_PRICE);
  const ask = Atomics.load(data, ASK_PRICE);
  if (bid === 0 || ask === 0) return;

  const currentPrice = _position === 'long' ? bid : ask; // exit against adverse side

  const hitTarget = _position === 'long'
    ? currentPrice >= _targetPrice
    : currentPrice <= _targetPrice;

  const hitStop = _position === 'long'
    ? currentPrice <= _stopPrice
    : currentPrice >= _stopPrice;

  if (!hitTarget && !hitStop) return;

  const exitSide = _position === 'long' ? 'sell' : 'buy';
  const exitPrice = hitTarget ? _targetPrice : _stopPrice;
  const txid = await placeLimitOrder(exitSide, exitPrice, orderAmount);

  // Calculate P&L (simplified — assumes fill at target/stop price)
  const rawPnl = _position === 'long'
    ? (exitPrice - _entryPrice) * orderAmount
    : (_entryPrice - exitPrice) * orderAmount;
  const fees = (exitPrice * orderAmount * 0.0016) + (_entryPrice * orderAmount * 0.0016);
  const netPnl = rawPnl - fees;

  _dailyPnl += netPnl;
  _totalPnl += netPnl;
  if (netPnl >= 0) _wins++; else _losses++;

  parentPort?.postMessage({
    type: 'fill',
    msg:  `${hitTarget ? '✅ TARGET' : '🛑 STOP'} hit @ ${exitPrice} | Net P&L: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(4)} | Total: $${_totalPnl.toFixed(4)} | W/L: ${_wins}/${_losses}`,
    pnl: netPnl, totalPnl: _totalPnl, wins: _wins, losses: _losses,
  });

  // ── Safety check after every fill ────────────────────────────────────────
  const state = _breaker.checkHealth(_totalPnl);
  if (state === SystemState.EMERGENCY_STOP) {
    _halted = true;
    parentPort?.postMessage({
      type: 'halt',
      msg: `🚨 CIRCUIT BREAKER — Drawdown $${_breaker.getDrawdown(_totalPnl).toFixed(2)} hit limit. All trading halted.`,
    });
  } else if (state === SystemState.WARNING) {
    parentPort?.postMessage({
      type: 'warning',
      msg: `⚠️ WARNING — Drawdown at 50%+ of limit ($${_breaker.getDrawdown(_totalPnl).toFixed(2)}). Proceed with caution.`,
    });
  }

  _position    = 'flat';
  _entryPrice  = 0;
  _stopPrice   = 0;
  _targetPrice = 0;
}

// ── Message from Engine (Thread B) ───────────────────────────────────────────
// Note: omsPort is passed in workerData as MessagePort
// We receive via parentPort in this simplified architecture
parentPort?.on('message', (msg: any) => {
  if (msg?.signal !== undefined) onSignal(msg);
});

// ── Monitor loop (every 250ms) ────────────────────────────────────────────────
setInterval(() => { monitorPosition(); }, 250);

parentPort?.postMessage({ type: 'status', msg: `OMS ready | DryRun: ${dryRun}` });
