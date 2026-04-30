// src/workers/feedWorker.ts
import { workerData, parentPort } from "worker_threads";
import WebSocket from "ws";

// src/shared/sharedBuffer.ts
var DEPTH = 10;
var BID_PRICE = 0;
var BID_QTY = 1;
var ASK_PRICE = 2;
var ASK_QTY = 3;
var TIMESTAMP = 4;
var BID_PRICES_START = 5;
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

// src/workers/feedWorker.ts
var { sharedBuffer, symbol } = workerData;
var data = new Float64Array(sharedBuffer);
var _bids = Array.from({ length: DEPTH }, () => [0, 0]);
var _asks = Array.from({ length: DEPTH }, () => [0, 0]);
var WS_URL = "wss://ws.kraken.com/v2";
function connect() {
  const ws = new WebSocket(WS_URL);
  ws.on("open", () => {
    parentPort?.postMessage({ type: "status", msg: `Feed connected to ${WS_URL}` });
    ws.send(JSON.stringify({
      method: "subscribe",
      params: { channel: "book", symbol: [symbol], depth: DEPTH }
    }));
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.channel !== "book" || !msg.data?.[0]) return;
    const entry = msg.data[0];
    const bids = entry.bids ?? [];
    const asks = entry.asks ?? [];
    const now = Date.now();
    if (bids.length > 0) {
      Atomics.store(data, BID_PRICE, bids[0].price);
      Atomics.store(data, BID_QTY, bids[0].qty);
    }
    if (asks.length > 0) {
      Atomics.store(data, ASK_PRICE, asks[0].price);
      Atomics.store(data, ASK_QTY, asks[0].qty);
    }
    Atomics.store(data, TIMESTAMP, now);
    const bidLen = Math.min(bids.length, DEPTH);
    const askLen = Math.min(asks.length, DEPTH);
    for (let i = 0; i < bidLen; i++) {
      Atomics.store(data, BID_PRICES_START + i, bids[i].price);
      Atomics.store(data, BID_QTYS_START + i, bids[i].qty);
    }
    for (let i = 0; i < askLen; i++) {
      Atomics.store(data, ASK_PRICES_START + i, asks[i].price);
      Atomics.store(data, ASK_QTYS_START + i, asks[i].qty);
    }
  });
  ws.on("close", () => {
    parentPort?.postMessage({ type: "status", msg: "Feed disconnected \u2014 reconnecting in 1s" });
    setTimeout(connect, 1e3);
  });
  ws.on("error", (err) => {
    parentPort?.postMessage({ type: "error", msg: err.message });
  });
}
connect();
