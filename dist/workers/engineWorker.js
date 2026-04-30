// src/workers/engineWorker.ts
import { workerData, parentPort } from "worker_threads";

// src/shared/sharedBuffer.ts
var DEPTH = 10;
var BID_PRICE = 0;
var BID_QTY = 1;
var ASK_PRICE = 2;
var ASK_QTY = 3;
var BID_QTYS_START = 5 + DEPTH;
var ASK_PRICES_START = 5 + DEPTH * 2;
var ASK_QTYS_START = 5 + DEPTH * 3;
var ATR = 5 + DEPTH * 4;
var VWAP = ATR + 1;
var OBI = ATR + 2;
var SIGNAL = ATR + 3;
var SIGNAL_PRICE = ATR + 4;
var SIGNAL_ATR = ATR + 5;
var REGIME_SCORE = ATR + 6;
var VWAP_VOL = ATR + 7;
var TOTAL_ELEMENTS = ATR + 8;
var BUFFER_BYTES = TOTAL_ELEMENTS * Float64Array.BYTES_PER_ELEMENT;

// src/workers/engineWorker.ts
var {
  sharedBuffer,
  omsPort,
  atrPeriod,
  dormantThreshold,
  volatileThreshold,
  volumeSpikeMultiplier,
  obiLongThreshold,
  obiShortThreshold,
  vwapBreakMin,
  stopAtrMult,
  targetAtrMult,
  makerFee
} = workerData;
var data = new Float64Array(sharedBuffer);
var _atr = 0;
var _prevMid = 0;
var _atrCount = 0;
var _trBuffer = new Array(atrPeriod).fill(0);
var VWAP_WINDOW = 200;
var _vwapMids = new Array(VWAP_WINDOW).fill(0);
var _vwapVols = new Array(VWAP_WINDOW).fill(0);
var _vwapIdx = 0;
var VOL_WINDOW = 20;
var _volBuffer = new Array(VOL_WINDOW).fill(0);
var _volIdx = 0;
var _volSum = 0;
var _lastLongTs = 0;
var _lastShortTs = 0;
var SIGNAL_COOLDOWN_MS = 3e4;
var _lastTick = 0;
var TICK_INTERVAL_MS = 100;
function breakevenAtr(price) {
  return 2 * makerFee * price / targetAtrMult;
}
function computeOBI() {
  let bidVol = 0;
  let askVol = 0;
  for (let i = 0; i < DEPTH; i++) {
    bidVol += Atomics.load(data, BID_QTYS_START + i);
    askVol += Atomics.load(data, ASK_QTYS_START + i);
  }
  const total = bidVol + askVol;
  return total > 0 ? bidVol / total : 0.5;
}
function updateATR(mid, volume, high, low) {
  if (_prevMid === 0) {
    _prevMid = mid;
    return;
  }
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
  _vwapMids[_vwapIdx] = mid;
  _vwapVols[_vwapIdx] = volume;
  _vwapIdx = (_vwapIdx + 1) % VWAP_WINDOW;
  _volSum -= _volBuffer[_volIdx];
  _volBuffer[_volIdx] = volume;
  _volSum += volume;
  _volIdx = (_volIdx + 1) % VOL_WINDOW;
}
function evaluate() {
  const now = Date.now();
  if (now - _lastTick < TICK_INTERVAL_MS) return;
  _lastTick = now;
  const bid = Atomics.load(data, BID_PRICE);
  const ask = Atomics.load(data, ASK_PRICE);
  const bidQty = Atomics.load(data, BID_QTY);
  const askQty = Atomics.load(data, ASK_QTY);
  if (bid === 0 || ask === 0) return;
  const mid = (bid + ask) / 2;
  const high = ask;
  const low = bid;
  const volume = bidQty + askQty;
  updateATR(mid, volume, high, low);
  if (_atr === 0) return;
  let pvSum = 0, vSum = 0;
  for (let i = 0; i < VWAP_WINDOW; i++) {
    pvSum += _vwapMids[i] * _vwapVols[i];
    vSum += _vwapVols[i];
  }
  const vwap = vSum > 0 ? pvSum / vSum : mid;
  const obi = computeOBI();
  const atrPct = _atr / mid;
  Atomics.store(data, ATR, _atr);
  Atomics.store(data, VWAP, vwap);
  Atomics.store(data, OBI, obi);
  Atomics.store(
    data,
    REGIME_SCORE,
    atrPct < dormantThreshold ? 0 : atrPct > volatileThreshold ? 2 : 1
  );
  if (atrPct < dormantThreshold) return;
  const feedHour = new Date(now).getUTCHours();
  if (feedHour < 6) return;
  const minAtr = breakevenAtr(mid);
  if (_atr < minAtr) {
    if (now - _lastSignalTs > 6e4) {
      parentPort?.postMessage({
        type: "status",
        msg: `ATR $${_atr.toFixed(2)} below fee breakeven $${minAtr.toFixed(2)} \u2014 waiting for volatility`
      });
      _lastSignalTs = now;
    }
    return;
  }
  const longReady = now - _lastLongTs >= SIGNAL_COOLDOWN_MS;
  const shortReady = now - _lastShortTs >= SIGNAL_COOLDOWN_MS;
  const avgVol = _volSum / VOL_WINDOW;
  if (volume < avgVol * volumeSpikeMultiplier) return;
  const distFromVwap = (mid - vwap) / vwap;
  if (distFromVwap > vwapBreakMin && obi > obiLongThreshold && longReady) {
    _lastLongTs = now;
    Atomics.store(data, SIGNAL, 1);
    Atomics.store(data, SIGNAL_PRICE, mid);
    Atomics.store(data, SIGNAL_ATR, _atr);
    omsPort.postMessage({
      signal: 1,
      price: mid,
      atr: _atr,
      stop: mid - _atr * stopAtrMult,
      target: mid + _atr * targetAtrMult,
      timestamp: now
    });
    parentPort?.postMessage({
      type: "signal",
      msg: `LONG @ ${mid.toFixed(2)} | ATR: $${_atr.toFixed(4)} (BE: $${minAtr.toFixed(4)}) | OBI: ${obi.toFixed(3)} | VWAP+${(distFromVwap * 100).toFixed(3)}%`
    });
  } else if (distFromVwap < -vwapBreakMin && obi < obiShortThreshold && shortReady) {
    _lastShortTs = now;
    Atomics.store(data, SIGNAL, -1);
    Atomics.store(data, SIGNAL_PRICE, mid);
    Atomics.store(data, SIGNAL_ATR, _atr);
    omsPort.postMessage({
      signal: -1,
      price: mid,
      atr: _atr,
      stop: mid + _atr * stopAtrMult,
      target: mid - _atr * targetAtrMult,
      timestamp: now
    });
    parentPort?.postMessage({
      type: "signal",
      msg: `SHORT @ ${mid.toFixed(2)} | ATR: $${_atr.toFixed(4)} (BE: $${minAtr.toFixed(4)}) | OBI: ${obi.toFixed(3)} | VWAP${(distFromVwap * 100).toFixed(3)}%`
    });
  }
}
function tick() {
  evaluate();
  setImmediate(tick);
}
setImmediate(tick);
