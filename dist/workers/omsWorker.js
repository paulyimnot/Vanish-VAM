// src/workers/omsWorker.ts
import { workerData, parentPort } from "worker_threads";
import { createHmac, createHash } from "crypto";
import https from "https";

// src/shared/sharedBuffer.ts
var DEPTH = 10;
var BID_PRICE = 0;
var ASK_PRICE = 2;
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

// src/engine/SafetyManager.ts
var CircuitBreaker = class {
  maxDrawdown;
  warnThreshold;
  peakPnl = 0;
  constructor(maxDrawdownUsd = 500) {
    this.maxDrawdown = maxDrawdownUsd;
    this.warnThreshold = maxDrawdownUsd * 0.5;
  }
  /**
   * Call after every closed trade with the cumulative realized P&L.
   * Returns the current system state.
   */
  checkHealth(cumulativePnl) {
    if (cumulativePnl > this.peakPnl) {
      this.peakPnl = cumulativePnl;
    }
    const drawdown = this.peakPnl - cumulativePnl;
    if (drawdown >= this.maxDrawdown) {
      console.error(
        `[SAFETY] EMERGENCY STOP \u2014 Drawdown $${drawdown.toFixed(2)} exceeded limit $${this.maxDrawdown}`
      );
      return 2 /* EMERGENCY_STOP */;
    }
    if (drawdown >= this.warnThreshold) {
      console.warn(
        `[SAFETY] WARNING \u2014 Drawdown $${drawdown.toFixed(2)} (${(drawdown / this.maxDrawdown * 100).toFixed(0)}% of limit)`
      );
      return 1 /* WARNING */;
    }
    return 0 /* HEALTHY */;
  }
  /** Current drawdown from peak (USD). */
  getDrawdown(cumulativePnl) {
    return Math.max(0, this.peakPnl - cumulativePnl);
  }
  /** Reset peak — call at start of each trading day. */
  resetPeak() {
    this.peakPnl = 0;
  }
};

// src/workers/omsWorker.ts
var {
  sharedBuffer,
  omsPort,
  // ← MessagePort from Engine (Thread B) — this is where signals arrive
  apiKey,
  apiSecret,
  symbol,
  dryRun,
  maxDailyLossRate,
  accountBalance,
  stopAtrMult,
  makerFee,
  riskPerTrade
} = workerData;
var data = new Float64Array(sharedBuffer);
var _position = "flat";
var _entryPrice = 0;
var _stopPrice = 0;
var _targetPrice = 0;
var _tradeAtr = 0;
var _tradeQty = 0;
var _trailingActive = false;
var _peakPriceSinceEntry = 0;
var _dailyPnl = 0;
var _totalPnl = 0;
var _currentBalance = accountBalance;
var _wins = 0;
var _losses = 0;
var _halted = false;
var _breaker = new CircuitBreaker(
  workerData.maxDrawdownUsd ?? 500
);
var SIGNAL_MAX_AGE_MS = 3e3;
function calcPositionSize(price, atr) {
  const stopDistanceUsd = price * atr * stopAtrMult / price;
  if (stopDistanceUsd <= 0) return 1e-3;
  const rawSize = _currentBalance * riskPerTrade / stopDistanceUsd;
  return parseFloat(rawSize.toFixed(8));
}
function sign(path, nonce, postData) {
  const secret = Buffer.from(apiSecret, "base64");
  const hash = createHash("sha256").update(String(nonce) + postData).digest();
  const msg = Buffer.concat([Buffer.from(path), hash]);
  return createHmac("sha512", secret).update(msg).digest("base64");
}
function krakenPost(path, params) {
  return new Promise((resolve, reject) => {
    const nonce = Date.now() * 1e3;
    const postData = new URLSearchParams({ nonce: String(nonce), ...params }).toString();
    const sig = sign(path, nonce, postData);
    const options = {
      hostname: "api.kraken.com",
      path,
      method: "POST",
      headers: {
        "API-Key": apiKey,
        "API-Sign": sig,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(body));
        }
      });
    });
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}
async function placeLimitOrder(side, price, qty) {
  if (dryRun) {
    const id = `DRY-${Date.now()}-${side}`;
    parentPort?.postMessage({ type: "order", msg: `[DRY RUN] ${side.toUpperCase()} ${qty} @ ${price.toFixed(2)} \u2192 ${id}` });
    return id;
  }
  try {
    const result = await krakenPost("/0/private/AddOrder", {
      ordertype: "limit",
      type: side,
      volume: String(qty),
      price: price.toFixed(2),
      pair: symbol.replace("/", ""),
      oflags: "post"
      // maker-only
    });
    const errors = result["error"];
    if (errors?.length) throw new Error(errors.join(", "));
    const txid = result["result"]?.["txid"]?.[0] ?? null;
    parentPort?.postMessage({ type: "order", msg: `${side.toUpperCase()} ${qty} @ ${price.toFixed(2)} \u2192 ${txid}` });
    return txid;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    parentPort?.postMessage({ type: "error", msg: `Order failed: ${msg}` });
    return null;
  }
}
async function onSignal(msg) {
  if (_halted) {
    parentPort?.postMessage({ type: "status", msg: "Signal ignored \u2014 bot halted." });
    return;
  }
  if (_position !== "flat") {
    parentPort?.postMessage({ type: "status", msg: "Signal ignored \u2014 position open." });
    return;
  }
  if (Date.now() - msg.timestamp > SIGNAL_MAX_AGE_MS) {
    parentPort?.postMessage({ type: "status", msg: `Signal rejected \u2014 ${Date.now() - msg.timestamp}ms stale` });
    return;
  }
  if (_dailyPnl / accountBalance <= -maxDailyLossRate) {
    _halted = true;
    parentPort?.postMessage({ type: "halt", msg: `Daily loss limit hit ($${_dailyPnl.toFixed(2)}). Halted.` });
    return;
  }
  const side = msg.signal === 1 ? "buy" : "sell";
  const entryPrice = msg.signal === 1 ? msg.price * (1 - 5e-4) : msg.price * (1 + 5e-4);
  const qty = calcPositionSize(entryPrice, msg.atr);
  const txid = await placeLimitOrder(side, entryPrice, qty);
  if (!txid) return;
  _position = msg.signal === 1 ? "long" : "short";
  _entryPrice = entryPrice;
  _stopPrice = msg.stop;
  _targetPrice = msg.target;
  _tradeAtr = msg.atr;
  _tradeQty = qty;
  _trailingActive = false;
  _peakPriceSinceEntry = entryPrice;
  parentPort?.postMessage({
    type: "status",
    msg: `OPEN ${_position.toUpperCase()} ${qty} BTC @ ${entryPrice.toFixed(2)} | Stop: ${_stopPrice.toFixed(2)} | Target: ${_targetPrice.toFixed(2)} | Risk: $${(qty * msg.atr * stopAtrMult).toFixed(2)}`
  });
}
async function monitorPosition() {
  if (_position === "flat" || _halted) return;
  const bid = Atomics.load(data, BID_PRICE);
  const ask = Atomics.load(data, ASK_PRICE);
  if (bid === 0 || ask === 0) return;
  const currentPrice = _position === "long" ? bid : ask;
  if (_position === "long") {
    if (currentPrice > _peakPriceSinceEntry) _peakPriceSinceEntry = currentPrice;
    if (!_trailingActive && currentPrice >= _entryPrice + _tradeAtr) {
      _trailingActive = true;
      _stopPrice = _entryPrice;
      parentPort?.postMessage({ type: "status", msg: `Trailing stop activated \u2014 stop moved to breakeven ${_stopPrice.toFixed(2)}` });
    }
    if (_trailingActive) {
      const trailStop = _peakPriceSinceEntry - _tradeAtr;
      if (trailStop > _stopPrice) _stopPrice = trailStop;
    }
  } else {
    if (currentPrice < _peakPriceSinceEntry) _peakPriceSinceEntry = currentPrice;
    if (!_trailingActive && currentPrice <= _entryPrice - _tradeAtr) {
      _trailingActive = true;
      _stopPrice = _entryPrice;
      parentPort?.postMessage({ type: "status", msg: `Trailing stop activated \u2014 stop moved to breakeven ${_stopPrice.toFixed(2)}` });
    }
    if (_trailingActive) {
      const trailStop = _peakPriceSinceEntry + _tradeAtr;
      if (trailStop < _stopPrice) _stopPrice = trailStop;
    }
  }
  const hitTarget = _position === "long" ? currentPrice >= _targetPrice : currentPrice <= _targetPrice;
  const hitStop = _position === "long" ? currentPrice <= _stopPrice : currentPrice >= _stopPrice;
  if (!hitTarget && !hitStop) return;
  const exitSide = _position === "long" ? "sell" : "buy";
  const exitPrice = hitTarget ? _targetPrice : _stopPrice;
  await placeLimitOrder(exitSide, exitPrice, _tradeQty);
  const rawPnl = _position === "long" ? (exitPrice - _entryPrice) * _tradeQty : (_entryPrice - exitPrice) * _tradeQty;
  const fees = exitPrice * _tradeQty * makerFee + _entryPrice * _tradeQty * makerFee;
  const netPnl = rawPnl - fees;
  _dailyPnl += netPnl;
  _totalPnl += netPnl;
  _currentBalance += netPnl;
  if (netPnl >= 0) _wins++;
  else _losses++;
  const winRate = _wins + _losses > 0 ? (_wins / (_wins + _losses) * 100).toFixed(1) : "N/A";
  parentPort?.postMessage({
    type: "fill",
    msg: `${hitTarget ? "\u2705 TARGET" : "\u{1F6D1} STOP"} | ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(4)} | Total: $${_totalPnl.toFixed(4)} | W/L: ${_wins}/${_losses} (${winRate}%) | Balance: $${_currentBalance.toFixed(2)}`,
    pnl: netPnl,
    totalPnl: _totalPnl,
    wins: _wins,
    losses: _losses,
    balance: _currentBalance
  });
  const state = _breaker.checkHealth(_totalPnl);
  if (state === 2 /* EMERGENCY_STOP */) {
    _halted = true;
    parentPort?.postMessage({
      type: "halt",
      msg: `\u{1F6A8} CIRCUIT BREAKER \u2014 Drawdown $${_breaker.getDrawdown(_totalPnl).toFixed(2)} hit limit.`
    });
  } else if (state === 1 /* WARNING */) {
    parentPort?.postMessage({
      type: "warning",
      msg: `\u26A0\uFE0F WARNING \u2014 Drawdown $${_breaker.getDrawdown(_totalPnl).toFixed(2)} at 50%+ of limit.`
    });
  }
  _position = "flat";
  _entryPrice = 0;
  _stopPrice = 0;
  _targetPrice = 0;
  _tradeAtr = 0;
  _tradeQty = 0;
  _trailingActive = false;
  _peakPriceSinceEntry = 0;
}
omsPort.on("message", (msg) => {
  const m = msg;
  if (typeof m?.signal === "number") {
    void onSignal(m);
  }
});
setInterval(() => {
  void monitorPosition();
}, 100);
parentPort?.postMessage({ type: "status", msg: `OMS ready | DryRun: ${dryRun} | Balance: $${accountBalance}` });
