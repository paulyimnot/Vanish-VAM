/**
 * VAM — Main Entry Point
 *
 * Bootstraps the 3-thread architecture:
 *   Thread A (feedWorker)   — Kraken WebSocket → SharedArrayBuffer
 *   Thread B (engineWorker) — ATR/VWAP/OBI signal → MessageChannel
 *   Thread C (omsWorker)    — Receives signal, places orders
 *
 * Wires a MessageChannel between Engine and OMS.
 * Logs all worker messages to stdout.
 */

import 'dotenv/config';
import { Worker, MessageChannel, isMainThread } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { BUFFER_BYTES } from './shared/sharedBuffer.js';
import { startJitterGuard } from './shared/jitterGuard.js';

if (!isMainThread) throw new Error('main.ts must run on main thread');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config from environment ────────────────────────────────────────────────────
const cfg = {
  apiKey:                process.env.KRAKEN_API_KEY    ?? '',
  apiSecret:             process.env.KRAKEN_API_SECRET ?? '',
  symbol:                process.env.SYMBOL            ?? 'BTC/USDT',
  orderAmount:           parseFloat(process.env.ORDER_AMOUNT            ?? '0.001'),
  accountBalance:        parseFloat(process.env.ACCOUNT_BALANCE         ?? '5000'),
  atrPeriod:             parseInt(  process.env.ATR_PERIOD              ?? '14', 10),
  dormantThreshold:      parseFloat(process.env.ATR_DORMANT_THRESHOLD   ?? '0.003'),
  volatileThreshold:     parseFloat(process.env.ATR_VOLATILE_THRESHOLD  ?? '0.02'),
  volumeSpikeMultiplier: parseFloat(process.env.VOLUME_SPIKE_MULTIPLIER ?? '2.0'),
  obiLongThreshold:      parseFloat(process.env.OBI_LONG_THRESHOLD      ?? '0.60'),
  obiShortThreshold:     parseFloat(process.env.OBI_SHORT_THRESHOLD     ?? '0.40'),
  vwapBreakMin:          parseFloat(process.env.VWAP_BREAK_MIN          ?? '0.0015'),
  stopAtrMult:           parseFloat(process.env.STOP_ATR_MULT           ?? '0.5'),
  targetAtrMult:         parseFloat(process.env.TARGET_ATR_MULT         ?? '1.5'),
  maxDailyLossRate:      parseFloat(process.env.MAX_DAILY_LOSS          ?? '0.03'),
  dryRun:                process.env.DRY_RUN !== 'false',
};

if (!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret)) {
  console.error('[VANISH] ERROR: KRAKEN_API_KEY and KRAKEN_API_SECRET required for live trading.');
  process.exit(1);
}

console.log('='.repeat(55));
console.log('  VANISH — Velocity Asymmetric Momentum Bot');
console.log('='.repeat(55));
console.log(`  Symbol:   ${cfg.symbol}`);
console.log(`  Amount:   ${cfg.orderAmount}`);
console.log(`  DryRun:   ${cfg.dryRun}`);
console.log(`  Strategy: VWAP Break + Volume Spike + OBI Filter`);
console.log('='.repeat(55));

// ── Shared memory ─────────────────────────────────────────────────────────────
const sharedBuffer = new SharedArrayBuffer(BUFFER_BYTES);

// ── Message channel: Engine (B) → OMS (C) ────────────────────────────────────
const { port1: enginePort, port2: omsPort } = new MessageChannel();

// ── Thread A: Feed ────────────────────────────────────────────────────────────
const feedWorker = new Worker(
  new URL('./workers/feedWorker.js', import.meta.url),
  { workerData: { sharedBuffer, symbol: cfg.symbol } }
);
feedWorker.on('message', (m: any) => console.log(`[FEED] ${m.msg}`));
feedWorker.on('error',   (e)      => console.error('[FEED ERROR]', e));

// ── Thread B: Engine ─────────────────────────────────────────────────────────
const engineWorker = new Worker(
  new URL('./workers/engineWorker.js', import.meta.url),
  {
    workerData: {
      sharedBuffer, omsPort: enginePort,
      ...cfg,
    },
    transferList: [enginePort],
  }
);
engineWorker.on('message', (m: any) => {
  const prefix = m.type === 'signal' ? '[SIGNAL]' : '[ENGINE]';
  console.log(`${prefix} ${m.msg}`);
});
engineWorker.on('error', (e) => console.error('[ENGINE ERROR]', e));

// ── Thread C: OMS ─────────────────────────────────────────────────────────────
const omsWorker = new Worker(
  new URL('./workers/omsWorker.js', import.meta.url),
  {
    workerData: {
      sharedBuffer, omsPort,
      apiKey:          cfg.apiKey,
      apiSecret:       cfg.apiSecret,
      symbol:          cfg.symbol,
      orderAmount:     cfg.orderAmount,
      dryRun:          cfg.dryRun,
      maxDailyLossRate: cfg.maxDailyLossRate,
      accountBalance:  cfg.accountBalance,
    },
    transferList: [omsPort],
  }
);
omsWorker.on('message', (m: any) => {
  const prefix = m.type === 'fill' ? '[FILL]' : m.type === 'halt' ? '[HALT]' : '[OMS]';
  console.log(`${prefix} ${m.msg}`);
  if (m.type === 'halt') {
    feedWorker.terminate();
    engineWorker.terminate();
    omsWorker.terminate();
    process.exit(0);
  }
});
omsWorker.on('error', (e) => console.error('[OMS ERROR]', e));

// ── Main-thread jitter guard ──────────────────────────────────────────────────
startJitterGuard(20, (reason) => {
  // 20ms threshold on main thread — not the hot path so relaxed limit
  console.warn(`[JITTER] ${reason}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[VANISH] Shutting down gracefully...');
  await Promise.all([
    feedWorker.terminate(),
    engineWorker.terminate(),
    omsWorker.terminate(),
  ]);
  process.exit(0);
});

console.log('[VANISH] All threads started. Press Ctrl+C to stop.\n');
