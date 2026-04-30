/**
 * THREAD A — Feed Worker
 *
 * Connects to Kraken WebSocket v2 and writes BBO + L2 depth
 * into the SharedArrayBuffer using Atomics for thread safety.
 *
 * No allocations in the hot path (message handler).
 * All objects (bids/asks arrays) are pre-allocated at startup.
 */

import { workerData, parentPort } from 'worker_threads';
import WebSocket from 'ws';
// Atomics is a Node.js global — no import needed
import {
  BID_PRICE, BID_QTY, ASK_PRICE, ASK_QTY, TIMESTAMP,
  BID_PRICES_START, BID_QTYS_START, ASK_PRICES_START, ASK_QTYS_START,
  DEPTH,
} from '../shared/sharedBuffer.js';

const { sharedBuffer, symbol } = workerData as {
  sharedBuffer: SharedArrayBuffer;
  symbol: string;
};

const data = new Float64Array(sharedBuffer);

// Pre-allocate reusable arrays — ZERO allocations in hot path
const _bids: [number, number][] = Array.from({ length: DEPTH }, () => [0, 0]);
const _asks: [number, number][] = Array.from({ length: DEPTH }, () => [0, 0]);

const WS_URL = 'wss://ws.kraken.com/v2';
let _reconnectDelay = 1000; // start at 1s, backs off to 30s max

function connect(): void {
  const ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    _reconnectDelay = 1000; // reset on successful connect
    parentPort?.postMessage({ type: 'status', msg: `Feed connected to ${WS_URL}` });
    ws.send(JSON.stringify({
      method: 'subscribe',
      params: { channel: 'book', symbol: [symbol], depth: DEPTH },
    }));

    // Heartbeat every 30s — keeps connection alive through Render's proxy timeout
    const heartbeat = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ method: 'ping' }));
      } else {
        clearInterval(heartbeat);
      }
    }, 30_000);

    ws.once('close', () => clearInterval(heartbeat));
  });

  ws.on('message', (raw: Buffer) => {
    // Parse — raw is Buffer (binary mode), avoids string conversion overhead
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.channel !== 'book' || !msg.data?.[0]) return;

    const entry = msg.data[0];
    const bids: { price: number; qty: number }[] = entry.bids ?? [];
    const asks: { price: number; qty: number }[] = entry.asks ?? [];
    const now = Date.now();

    // Write BBO atomically
    if (bids.length > 0) {
      Atomics.store(data, BID_PRICE, bids[0].price);
      Atomics.store(data, BID_QTY,   bids[0].qty);
    }
    if (asks.length > 0) {
      Atomics.store(data, ASK_PRICE, asks[0].price);
      Atomics.store(data, ASK_QTY,   asks[0].qty);
    }
    Atomics.store(data, TIMESTAMP, now);

    // Write L2 depth
    const bidLen = Math.min(bids.length, DEPTH);
    const askLen = Math.min(asks.length, DEPTH);
    for (let i = 0; i < bidLen; i++) {
      Atomics.store(data, BID_PRICES_START + i, bids[i].price);
      Atomics.store(data, BID_QTYS_START   + i, bids[i].qty);
    }
    for (let i = 0; i < askLen; i++) {
      Atomics.store(data, ASK_PRICES_START + i, asks[i].price);
      Atomics.store(data, ASK_QTYS_START   + i, asks[i].qty);
    }
  });

  ws.on('close', () => {
    parentPort?.postMessage({ type: 'status', msg: `Feed disconnected — reconnecting in ${_reconnectDelay / 1000}s` });
    setTimeout(connect, _reconnectDelay);
    _reconnectDelay = Math.min(_reconnectDelay * 2, 30_000); // exponential backoff up to 30s
  });

  ws.on('error', (err: Error) => {
    parentPort?.postMessage({ type: 'error', msg: err.message });
  });
}

connect();
