/**
 * VAM — Main Entry Point
 *
 * Bootstraps the 3-thread architecture:
 *   Thread A (feedWorker)   — Kraken WebSocket → SharedArrayBuffer
 *   Thread B (engineWorker) — ATR/VWAP/OBI signal → MessageChannel → OMS
 *   Thread C (omsWorker)    — Receives signal, places orders, manages position
 */

import 'dotenv/config';
import { Worker, MessageChannel, isMainThread } from 'worker_threads';
import { BUFFER_BYTES } from './shared/sharedBuffer.js';
import { startJitterGuard } from './shared/jitterGuard.js';

if (!isMainThread) throw new Error('main.ts must run on main thread');

// ── Config ────────────────────────────────────────────────────────────────────
const e = process.env;
const makerFee    = parseFloat(e['MAKER_FEE']     ?? '0.0016'); // Kraken default 0.16%
const riskPerTrade = parseFloat(e['RISK_PER_TRADE'] ?? '0.01'); // 1% of balance per trade
const stopAtrMult  = parseFloat(e['STOP_ATR_MULT']  ?? '0.5');
const targetAtrMult = parseFloat(e['TARGET_ATR_MULT'] ?? '1.5');
const accountBalance = parseFloat(e['ACCOUNT_BALANCE'] ?? '5000');

const cfg = {
  apiKey:                e['KRAKEN_API_KEY']          ?? '',
  apiSecret:             e['KRAKEN_API_SECRET']        ?? '',
  symbol:                e['SYMBOL']                   ?? 'BTC/USDT',
  accountBalance,
  riskPerTrade,
  makerFee,
  stopAtrMult,
  targetAtrMult,
  atrPeriod:             parseInt(e['ATR_PERIOD']              ?? '14', 10),
  dormantThreshold:      parseFloat(e['ATR_DORMANT_THRESHOLD'] ?? '0.003'),
  volatileThreshold:     parseFloat(e['ATR_VOLATILE_THRESHOLD'] ?? '0.02'),
  volumeSpikeMultiplier: parseFloat(e['VOLUME_SPIKE_MULTIPLIER'] ?? '2.0'),
  obiLongThreshold:      parseFloat(e['OBI_LONG_THRESHOLD']    ?? '0.60'),
  obiShortThreshold:     parseFloat(e['OBI_SHORT_THRESHOLD']   ?? '0.40'),
  vwapBreakMin:          parseFloat(e['VWAP_BREAK_MIN']        ?? '0.0015'),
  maxDailyLossRate:      parseFloat(e['MAX_DAILY_LOSS']        ?? '0.03'),
  maxDrawdownUsd:        parseFloat(e['MAX_DRAWDOWN_USD']      ?? '500'),
  dryRun:                e['DRY_RUN'] !== 'false',
};

if (!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret)) {
  console.error('[VANISH] ERROR: KRAKEN_API_KEY and KRAKEN_API_SECRET required for live trading.');
  process.exit(1);
}

// ── Startup banner ────────────────────────────────────────────────────────────
const breakeven = ((2 * makerFee * 78000) / targetAtrMult).toFixed(0); // approx at $78k BTC
console.log('='.repeat(60));
console.log('  VANISH — Velocity Asymmetric Momentum Bot v2');
console.log('='.repeat(60));
console.log(`  Symbol:         ${cfg.symbol}`);
console.log(`  Account:        $${accountBalance}`);
console.log(`  Risk/trade:     ${(riskPerTrade * 100).toFixed(1)}% of balance`);
console.log(`  R:R ratio:      1:${targetAtrMult / stopAtrMult}`);
console.log(`  Maker fee:      ${(makerFee * 100).toFixed(2)}%`);
console.log(`  ATR breakeven:  ~$${breakeven} per BTC (fees covered at this ATR)`);
console.log(`  DryRun:         ${cfg.dryRun}`);
console.log(`  Trading hours:  06:00–24:00 UTC (skips thin overnight session)`);
console.log('='.repeat(60));

// ── Shared memory ─────────────────────────────────────────────────────────────
const sharedBuffer = new SharedArrayBuffer(BUFFER_BYTES);

// ── MessageChannel: Engine (B) → OMS (C) ─────────────────────────────────────
const { port1: enginePort, port2: omsPort } = new MessageChannel();

// ── Thread A: Feed ────────────────────────────────────────────────────────────
const feedWorker = new Worker(
  new URL('./workers/feedWorker.js', import.meta.url),
  { workerData: { sharedBuffer, symbol: cfg.symbol } }
);
feedWorker.on('message', (m: { msg: string }) => console.log(`[FEED]   ${m.msg}`));
feedWorker.on('error',   (err: Error)          => console.error('[FEED ERROR]', err.message));

// ── Thread B: Engine ──────────────────────────────────────────────────────────
const engineWorker = new Worker(
  new URL('./workers/engineWorker.js', import.meta.url),
  {
    workerData: { sharedBuffer, omsPort: enginePort, ...cfg },
    transferList: [enginePort],
  }
);
engineWorker.on('message', (m: { type: string; msg: string }) => {
  const prefix = m.type === 'signal' ? '[SIGNAL]' : '[ENGINE]';
  console.log(`${prefix} ${m.msg}`);
});
engineWorker.on('error', (err: Error) => console.error('[ENGINE ERROR]', err.message));

// ── Thread C: OMS ─────────────────────────────────────────────────────────────
const omsWorker = new Worker(
  new URL('./workers/omsWorker.js', import.meta.url),
  {
    workerData: {
      sharedBuffer, omsPort,
      apiKey:          cfg.apiKey,
      apiSecret:       cfg.apiSecret,
      symbol:          cfg.symbol,
      dryRun:          cfg.dryRun,
      maxDailyLossRate: cfg.maxDailyLossRate,
      maxDrawdownUsd:  cfg.maxDrawdownUsd,
      accountBalance:  cfg.accountBalance,
      riskPerTrade:    cfg.riskPerTrade,
      makerFee:        cfg.makerFee,
      stopAtrMult:     cfg.stopAtrMult,
    },
    transferList: [omsPort],
  }
);
omsWorker.on('message', (m: { type: string; msg: string }) => {
  const labels: Record<string, string> = { fill: '[FILL] ', halt: '[HALT] ', warning: '[WARN] ', order: '[ORDER]', status: '[OMS]  ', error: '[ERROR]' };
  console.log(`${labels[m.type] ?? '[OMS]  '} ${m.msg}`);
  if (m.type === 'halt') {
    void Promise.all([feedWorker.terminate(), engineWorker.terminate(), omsWorker.terminate()])
      .then(() => process.exit(0));
  }
});
omsWorker.on('error', (err: Error) => console.error('[OMS ERROR]', err.message));

// ── Jitter guard (main thread) ────────────────────────────────────────────────
startJitterGuard(20, (reason) => { console.warn(`[JITTER] ${reason}`); });

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[VANISH] Shutting down...');
  void Promise.all([feedWorker.terminate(), engineWorker.terminate(), omsWorker.terminate()])
    .then(() => process.exit(0));
});

console.log('[VANISH] All threads running. Ctrl+C to stop.\n');
