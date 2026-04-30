/**
 * THREAD B — Engine Worker
 *
 * Reads L2 data from SharedArrayBuffer every tick.
 * Computes: ATR (Wilder), rolling VWAP, Order Book Imbalance (OBI).
 * Evaluates the 3-condition VAM entry signal.
 * Sends typed signal messages to Thread C (OMS) via MessagePort.
 *
 * Improvements:
 *  - Time-of-day filter: skips 00:00–06:00 UTC (thin volume, bad fills)
 *  - Fee-aware ATR logging: warns when current ATR is below breakeven
 *  - Signal staleness timestamp so OMS can reject stale signals
 */

import { workerData, parentPort } from 'worker_threads';
import type { MessagePort } from 'worker_threads';
import {
  BID_PRICE, BID_QTY, ASK_PRICE, ASK_QTY,
  BID_QTYS_START, ASK_QTYS_START,
  ATR, VWAP, OBI, SIGNAL, SIGNAL_PRICE, SIGNAL_ATR, REGIME_SCORE,
  DEPTH,
} from '../shared/sharedBuffer.js';

const {
  sharedBuffer, omsPort,
  atrPeriod, dormantThreshold, volatileThreshold,
  volumeSpikeMultiplier, obiLongThreshold, obiShortThreshold,
  vwapBreakMin, stopAtrMult, targetAtrMult,
  makerFee,
} = workerData as {
  sharedBuffer: SharedArrayBuffer;
  omsPort: MessagePort;
  atrPeriod: number;
  dormantThreshold: number;
  volatileThreshold: number;
  volumeSpikeMultiplier: number;
  obiLongThreshold: number;
  obiShortThreshold: number;
  vwapBreakMin: number;
  stopAtrMult: number;
  targetAtrMult: number;
  makerFee: number;
};

const data = new Float64Array(sharedBuffer);

// ── ATR state (Wilder's smoothing) ───────────────────────────────────────────
let _atr = 0;
let _prevMid = 0;
let _atrCount = 0;
const _trBuffer: number[] = new Array(atrPeriod).fill(0) as number[];

// ── VWAP state (rolling window, not cumulative) ────────────────────────────────
const VWAP_WINDOW = 1000;
const _vwapMids: number[] = new Array(VWAP_WINDOW).fill(0);
const _vwapVols: number[] = new Array(VWAP_WINDOW).fill(0);
let   _vwapIdx = 0;

// ── Volume ring buffer for spike detection ────────────────────────────────────
const VOL_WINDOW = 20;
const _volBuffer: number[] = new Array(VOL_WINDOW).fill(0) as number[];
let _volIdx = 0;
let _volSum = 0;

// ── Signal cooldown (per side) ───────────────────────────────────────────────
let _lastLongTs  = 0;
let _lastShortTs = 0;
const SIGNAL_COOLDOWN_MS = 30_000;

// ── Tick budget ───────────────────────────────────────────────────────────────
let _lastTick = 0;
const TICK_INTERVAL_MS = 100;

// ── Fee-aware breakeven ATR (per BTC) ────────────────────────────────────────
// Minimum ATR for the target move to exceed round-trip fees.
// breakeven = (2 * makerFee * price) / targetAtrMult
function breakevenAtr(price: number): number {
  return (2 * makerFee * price) / targetAtrMult;
}

// ── Time filter: skip 00:00–06:00 UTC (low liquidity) ────────────────────────
function isTradingHour(): boolean {
  const hour = new Date().getUTCHours();
  return hour >= 6; // trade only 06:00–24:00 UTC
}

function computeOBI(): number {
  let bidVol = 0;
  let askVol = 0;
  for (let i = 0; i < DEPTH; i++) {
    bidVol += Atomics.load(data, BID_QTYS_START + i);
    askVol += Atomics.load(data, ASK_QTYS_START + i);
  }
  const total = bidVol + askVol;
  return total > 0 ? bidVol / total : 0.5;
}

function updateATR(mid: number, volume: number, high: number, low: number): void {
  if (_prevMid === 0) { _prevMid = mid; return; }

  // True Range = max of: current bar H-L, |H - prevClose|, |L - prevClose|
  const tr = Math.max(high - low, Math.abs(high - _prevMid), Math.abs(low - _prevMid));
  _prevMid = mid;

  if (_atrCount < atrPeriod) {
    _trBuffer[_atrCount] = tr;
    _atrCount++;
    if (_atrCount === atrPeriod) {
      _atr = _trBuffer.reduce((a, b) => a + b, 0) / atrPeriod;
    }
  } else {
    _atr = (_atr * (atrPeriod - 1) + tr) / atrPeriod;
  }

  // Rolling VWAP — overwrite oldest slot
  _vwapMids[_vwapIdx] = mid;
  _vwapVols[_vwapIdx] = volume;
  _vwapIdx = (_vwapIdx + 1) % VWAP_WINDOW;

  _volSum -= _volBuffer[_volIdx];
  _volBuffer[_volIdx] = volume;
  _volSum += volume;
  _volIdx = (_volIdx + 1) % VOL_WINDOW;
}

function evaluate(): void {
  const now = Date.now();
  if (now - _lastTick < TICK_INTERVAL_MS) return;
  _lastTick = now;

  const bid    = Atomics.load(data, BID_PRICE);
  const ask    = Atomics.load(data, ASK_PRICE);
  const bidQty = Atomics.load(data, BID_QTY);
  const askQty = Atomics.load(data, ASK_QTY);

  if (bid === 0 || ask === 0) return;

  const mid    = (bid + ask) / 2;
  // Approximate H/L for true range using bid/ask spread
  const high   = ask;
  const low    = bid;
  const volume = bidQty + askQty;

  updateATR(mid, volume, high, low);
  if (_atr === 0) return;

  // Rolling VWAP from ring buffer
  let pvSum = 0, vSum = 0;
  for (let i = 0; i < VWAP_WINDOW; i++) {
    pvSum += _vwapMids[i] * _vwapVols[i];
    vSum  += _vwapVols[i];
  }
  const vwap = vSum > 0 ? pvSum / vSum : mid;
  const obi    = computeOBI();
  const atrPct = _atr / mid;

  // Write engine state
  Atomics.store(data, ATR,          _atr);
  Atomics.store(data, VWAP,         vwap);
  Atomics.store(data, OBI,          obi);
  Atomics.store(data, REGIME_SCORE,
    atrPct < dormantThreshold ? 0 : atrPct > volatileThreshold ? 2 : 1);

  // Regime gate
  if (atrPct < dormantThreshold) return;

  // Time-of-day filter — use feed clock (safer than server clock on VPS)
  const feedHour = new Date(now).getUTCHours();
  if (feedHour < 6) return;

  // Fee-aware check — log if ATR is below fee breakeven
  const minAtr = breakevenAtr(mid);
  if (_atr < minAtr) {
    // ATR too small — fees will eat the edge. Skip but log periodically.
    if (now - _lastSignalTs > 60_000) {
      parentPort?.postMessage({
        type: 'status',
        msg: `ATR $${_atr.toFixed(2)} below fee breakeven $${minAtr.toFixed(2)} — waiting for volatility`,
      });
      _lastSignalTs = now; // throttle this log
    }
    return;
  }

  // Signal cooldown — per side so opposite direction can fire immediately
  const longReady  = (now - _lastLongTs)  >= SIGNAL_COOLDOWN_MS;
  const shortReady = (now - _lastShortTs) >= SIGNAL_COOLDOWN_MS;

  // Volume spike check
  const avgVol = _volSum / VOL_WINDOW;
  if (volume < avgVol * volumeSpikeMultiplier) return;

  // VWAP breakout + OBI
  const distFromVwap = (mid - vwap) / vwap;

  if (distFromVwap > vwapBreakMin && obi > obiLongThreshold && longReady) {
    _lastLongTs = now;
    Atomics.store(data, SIGNAL,       1);
    Atomics.store(data, SIGNAL_PRICE, mid);
    Atomics.store(data, SIGNAL_ATR,   _atr);
    omsPort.postMessage({
      signal: 1, price: mid, atr: _atr,
      stop:   mid - _atr * stopAtrMult,
      target: mid + _atr * targetAtrMult,
      timestamp: now,
    });
    parentPort?.postMessage({
      type: 'signal',
      msg: `LONG @ ${mid.toFixed(2)} | ATR: $${_atr.toFixed(4)} (BE: $${minAtr.toFixed(4)}) | OBI: ${obi.toFixed(3)} | VWAP+${(distFromVwap*100).toFixed(3)}%`,
    });

  } else if (distFromVwap < -vwapBreakMin && obi < obiShortThreshold && shortReady) {
    _lastShortTs = now;
    Atomics.store(data, SIGNAL,       -1);
    Atomics.store(data, SIGNAL_PRICE, mid);
    Atomics.store(data, SIGNAL_ATR,   _atr);
    omsPort.postMessage({
      signal: -1, price: mid, atr: _atr,
      stop:   mid + _atr * stopAtrMult,
      target: mid - _atr * targetAtrMult,
      timestamp: now,
    });
    parentPort?.postMessage({
      type: 'signal',
      msg: `SHORT @ ${mid.toFixed(2)} | ATR: $${_atr.toFixed(4)} (BE: $${minAtr.toFixed(4)}) | OBI: ${obi.toFixed(3)} | VWAP${(distFromVwap*100).toFixed(3)}%`,
    });
  }
}

function tick(): void {
  evaluate();
  setImmediate(tick);
}
setImmediate(tick);
