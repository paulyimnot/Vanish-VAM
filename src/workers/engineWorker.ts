/**
 * THREAD B — Engine Worker
 *
 * Reads L2 data from SharedArrayBuffer every tick.
 * Computes: ATR (Wilder), rolling VWAP, Order Book Imbalance (OBI).
 * Evaluates the 3-condition VAM entry signal.
 * Sends typed signal messages to Thread C (OMS) via MessagePort.
 *
 * Design: setImmediate-driven loop (not setInterval) for minimal jitter.
 */

import { workerData, parentPort, MessagePort } from 'worker_threads';
import Atomics from 'atomics';
import {
  BID_PRICE, BID_QTY, ASK_PRICE, ASK_QTY, TIMESTAMP,
  BID_PRICES_START, BID_QTYS_START, ASK_PRICES_START, ASK_QTYS_START,
  ATR, VWAP, OBI, SIGNAL, SIGNAL_PRICE, SIGNAL_ATR, REGIME_SCORE, VWAP_VOL,
  DEPTH,
} from '../shared/sharedBuffer.js';

const {
  sharedBuffer, omsPort,
  atrPeriod, dormantThreshold, volatileThreshold,
  volumeSpikeMultiplier, obiLongThreshold, obiShortThreshold,
  vwapBreakMin, stopAtrMult, targetAtrMult,
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
};

const data = new Float64Array(sharedBuffer);

// ── ATR state (Wilder's smoothing) ──────────────────────────────────────────
let _atr = 0;
let _prevMid = 0;
let _atrCount = 0;
const _trBuffer: number[] = new Array(atrPeriod).fill(0);

// ── VWAP state (rolling, resets on candle boundary) ──────────────────────────
let _vwapPV = 0; // price * volume cumulative
let _vwapV  = 0; // volume cumulative

// ── Volume tracking for spike detection ──────────────────────────────────────
const VOL_WINDOW = 20;
const _volBuffer: number[] = new Array(VOL_WINDOW).fill(0);
let   _volIdx = 0;
let   _volSum = 0;

// ── Signal cooldown ──────────────────────────────────────────────────────────
let _lastSignalTs = 0;
const SIGNAL_COOLDOWN_MS = 60_000; // 60s between signals

// ── Tick budget (check every 100ms max) ──────────────────────────────────────
let _lastTick = 0;
const TICK_INTERVAL_MS = 100;

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

function updateATR(mid: number, volume: number): void {
  if (_prevMid === 0) { _prevMid = mid; return; }

  const tr = Math.abs(mid - _prevMid);
  _prevMid = mid;

  if (_atrCount < atrPeriod) {
    _trBuffer[_atrCount] = tr;
    _atrCount++;
    if (_atrCount === atrPeriod) {
      _atr = _trBuffer.reduce((a, b) => a + b, 0) / atrPeriod;
    }
  } else {
    // Wilder's smoothing
    _atr = (_atr * (atrPeriod - 1) + tr) / atrPeriod;
  }

  // Rolling VWAP
  _vwapPV += mid * volume;
  _vwapV  += volume;

  // Rolling volume buffer for spike detection
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

  if (bid === 0 || ask === 0) return; // feed not ready

  const mid    = (bid + ask) / 2;
  const spread = ask - bid;
  const volume = bidQty + askQty; // proxy for tick volume

  updateATR(mid, volume);

  if (_atr === 0) return; // need warmup

  const vwap  = _vwapV > 0 ? _vwapPV / _vwapV : mid;
  const obi   = computeOBI();
  const atrPct = _atr / mid;

  // ── Write engine state to shared buffer ───────────────────────────────────
  Atomics.store(data, ATR,          _atr);
  Atomics.store(data, VWAP,         vwap);
  Atomics.store(data, OBI,          obi);
  Atomics.store(data, REGIME_SCORE,
    atrPct < dormantThreshold ? 0 : atrPct > volatileThreshold ? 2 : 1);

  // ── Regime gate ───────────────────────────────────────────────────────────
  if (atrPct < dormantThreshold) return; // too quiet — fees > edge

  // ── Signal cooldown ───────────────────────────────────────────────────────
  if (now - _lastSignalTs < SIGNAL_COOLDOWN_MS) return;

  // ── Volume spike check ────────────────────────────────────────────────────
  const avgVol = _volSum / VOL_WINDOW;
  if (volume < avgVol * volumeSpikeMultiplier) return;

  // ── VWAP breakout + OBI check ─────────────────────────────────────────────
  const distFromVwap = (mid - vwap) / vwap;

  if (distFromVwap > vwapBreakMin && obi > obiLongThreshold) {
    // LONG signal
    _lastSignalTs = now;
    Atomics.store(data, SIGNAL,       1);
    Atomics.store(data, SIGNAL_PRICE, mid);
    Atomics.store(data, SIGNAL_ATR,   _atr);
    omsPort.postMessage({
      signal: 1, price: mid, atr: _atr,
      stop: mid - _atr * stopAtrMult,
      target: mid + _atr * targetAtrMult,
      timestamp: now,
    });
    parentPort?.postMessage({ type: 'signal', msg: `LONG @ ${mid} | ATR: ${_atr.toFixed(2)} | OBI: ${obi.toFixed(3)}` });

  } else if (distFromVwap < -vwapBreakMin && obi < obiShortThreshold) {
    // SHORT signal
    _lastSignalTs = now;
    Atomics.store(data, SIGNAL,       -1);
    Atomics.store(data, SIGNAL_PRICE, mid);
    Atomics.store(data, SIGNAL_ATR,   _atr);
    omsPort.postMessage({
      signal: -1, price: mid, atr: _atr,
      stop: mid + _atr * stopAtrMult,
      target: mid - _atr * targetAtrMult,
      timestamp: now,
    });
    parentPort?.postMessage({ type: 'signal', msg: `SHORT @ ${mid} | ATR: ${_atr.toFixed(2)} | OBI: ${obi.toFixed(3)}` });
  }
}

// ── Self-scheduling setImmediate loop ─────────────────────────────────────────
function tick(): void {
  evaluate();
  setImmediate(tick);
}
setImmediate(tick);
