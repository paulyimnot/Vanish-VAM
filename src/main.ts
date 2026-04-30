/**
 * VAM — Main Entry Point
 *
 * Bootstraps the 3-thread architecture:
 *   Thread A (feedWorker)   — Kraken WebSocket → SharedArrayBuffer
 *   Thread B (engineWorker) — ATR/VWAP/OBI signal → MessageChannel → OMS
 *   Thread C (omsWorker)    — Receives signal, places orders, manages position
 */

import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Worker, MessageChannel, isMainThread } from 'worker_threads';
import { BUFFER_BYTES } from './shared/sharedBuffer.js';
import { startJitterGuard } from './shared/jitterGuard.js';

if (!isMainThread) throw new Error('main.ts must run on main thread');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Config ────────────────────────────────────────────────────────────────────
const e = process.env;
const makerFee    = parseFloat(e['MAKER_FEE']     ?? '0.0016'); // Kraken default 0.16%
const riskPerTrade = parseFloat(e['RISK_PER_TRADE'] ?? '0.01'); // 1% of balance per trade
const stopAtrMult  = parseFloat(e['STOP_ATR_MULT']  ?? '0.5');
const targetAtrMult = parseFloat(e['TARGET_ATR_MULT'] ?? '1.5');
const accountBalance = parseFloat(e['ACCOUNT_BALANCE'] ?? '5000');

const symbol = e['SYMBOL'] ?? 'BTC/USDT';

// ── Auto-load Presets ────────────────────────────────────────────────────────
let p: Record<string, number> = {};
try {
  const presets = JSON.parse(fs.readFileSync(new URL('../presets.json', import.meta.url), 'utf8'));
  const presetKey = symbol.replace('/', '');
  if (presets[presetKey]) {
    p = presets[presetKey].settings;
    console.log(`\n[VANISH] ⚡ Auto-loaded optimized preset for ${symbol}\n`);
  }
} catch (err) { /* ignore if no preset file */ }

const cfg = {
  apiKey:                e['KRAKEN_API_KEY']          ?? '',
  apiSecret:             e['KRAKEN_API_SECRET']        ?? '',
  symbol:                symbol,
  accountBalance,
  riskPerTrade,
  makerFee,
  stopAtrMult:           p['STOP_ATR_MULT'] ?? stopAtrMult,
  targetAtrMult:         p['TARGET_ATR_MULT'] ?? targetAtrMult,
  atrPeriod:             parseInt(e['ATR_PERIOD']              ?? '14', 10),
  dormantThreshold:      p['ATR_DORMANT_THRESHOLD'] ?? parseFloat(e['ATR_DORMANT_THRESHOLD'] ?? '0.003'),
  volatileThreshold:     parseFloat(e['ATR_VOLATILE_THRESHOLD'] ?? '0.02'),
  volumeSpikeMultiplier: p['VOLUME_SPIKE_MULTIPLIER'] ?? parseFloat(e['VOLUME_SPIKE_MULTIPLIER'] ?? '2.0'),
  obiLongThreshold:      parseFloat(e['OBI_LONG_THRESHOLD']    ?? '0.60'),
  obiShortThreshold:     parseFloat(e['OBI_SHORT_THRESHOLD']   ?? '0.40'),
  vwapBreakMin:          p['VWAP_BREAK_MIN'] ?? parseFloat(e['VWAP_BREAK_MIN']        ?? '0.0015'),
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

// ── Dashboard Server (HTTP + WS) ──────────────────────────────────────────────
let stats = { pnl: 0, wins: 0, losses: 0, balance: accountBalance };

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    fs.readFile(join(__dirname, '../public/index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading index.html'); }
      else { res.writeHead(200, {'Content-Type': 'text/html'}); res.end(data); }
    });
  } else {
    res.writeHead(404); res.end();
  }
});

let _botRunning = true;

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', dryRun: cfg.dryRun, symbol: cfg.symbol, balance: accountBalance, running: _botRunning }));
  ws.send(JSON.stringify({ type: 'stats', ...stats }));

  // Handle Start/Stop commands from the dashboard browser
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { cmd?: string };
      if (msg.cmd === 'stop' && _botRunning) {
        _botRunning = false;
        omsWorker.postMessage({ cmd: 'pause' });
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'paused' })); });
        console.log('[DASHBOARD] ⏸ Bot PAUSED by user');
      } else if (msg.cmd === 'start' && !_botRunning) {
        _botRunning = true;
        omsWorker.postMessage({ cmd: 'resume' });
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'resumed' })); });
        console.log('[DASHBOARD] ▶ Bot RESUMED by user');
      }
    } catch { /* ignore bad messages */ }
  });
});

const DASHBOARD_PORT = parseInt(process.env['PORT'] ?? '8080', 10);
server.listen(DASHBOARD_PORT, () => {
  console.log(`\n[DASHBOARD] 🌐 Live at http://localhost:${DASHBOARD_PORT}\n`);
});

function broadcastLog(msg: string) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify({ type: 'log', msg }));
  });
}

// ── Shared memory ─────────────────────────────────────────────────────────────
const sharedBuffer = new SharedArrayBuffer(BUFFER_BYTES);

// ── MessageChannel: Engine (B) → OMS (C) ─────────────────────────────────────
const { port1: enginePort, port2: omsPort } = new MessageChannel();

// ── Thread A: Feed ────────────────────────────────────────────────────────────
const feedWorker = new Worker(
  new URL('./workers/feedWorker.js', import.meta.url),
  { workerData: { sharedBuffer, symbol: cfg.symbol } }
);
feedWorker.on('message', (m: { msg: string }) => {
  const s = `[FEED]   ${m.msg}`;
  console.log(s); broadcastLog(s);
});
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
  const s = `${prefix} ${m.msg}`;
  console.log(s); broadcastLog(s);
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
omsWorker.on('message', (m: { type: string; msg: string; pnl?: number; totalPnl?: number; wins?: number; losses?: number; balance?: number }) => {
  const labels: Record<string, string> = { fill: '[FILL] ', halt: '[HALT] ', warning: '[WARN] ', order: '[ORDER]', status: '[OMS]  ', error: '[ERROR]' };
  const s = `${labels[m.type] ?? '[OMS]  '} ${m.msg}`;
  console.log(s); broadcastLog(s);
  
  if (m.type === 'fill' && m.totalPnl !== undefined) {
    stats = { pnl: m.totalPnl, wins: m.wins || 0, losses: m.losses || 0, balance: m.balance || accountBalance };
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(JSON.stringify({ type: 'stats', ...stats }));
    });
  }

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
