/**
 * calcWorker — Runs inside the Processor worker pool.
 *
 * Receives CalcInput via postMessage, performs the calculation,
 * posts CalcOutput back. Stays alive for reuse (no process.exit).
 */

import { parentPort } from 'worker_threads';
import type { CalcInput, CalcOutput } from '../engine/Processor.js';

if (!parentPort) throw new Error('calcWorker must run as a Worker thread');

parentPort.on('message', (input: CalcInput) => {
  const start = performance.now();

  let result: number | number[];

  switch (input.type) {
    case 'atr':
      result = calcATR(input.prices, input.period ?? 14);
      break;

    case 'vwap':
      result = calcVWAP(input.prices, input.volumes ?? []);
      break;

    case 'obi':
      result = calcOBI(input.prices);
      break;

    case 'features':
      result = calcFeatureVector(input.prices, input.volumes ?? [], input.period ?? 14);
      break;

    default: {
      // Exhaustive check — strict TS will catch unhandled cases
      const _exhaustive: never = input.type;
      result = 0;
      void _exhaustive;
    }
  }

  const output: CalcOutput = {
    type: input.type,
    result,
    durationMs: performance.now() - start,
  };

  parentPort!.postMessage(output);
});

// ── Calculation implementations ────────────────────────────────────────────────

/** Wilder's ATR over a price series (last N periods). */
function calcATR(prices: number[], period: number): number {
  if (prices.length < period + 1) return 0;

  const trs: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    trs.push(Math.abs(prices[i] - prices[i - 1]));
  }

  // Seed with simple average
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/** Rolling VWAP over matched price and volume arrays. */
function calcVWAP(prices: number[], volumes: number[]): number {
  if (prices.length === 0 || prices.length !== volumes.length) return 0;
  let pv = 0;
  let v  = 0;
  for (let i = 0; i < prices.length; i++) {
    pv += prices[i] * volumes[i];
    v  += volumes[i];
  }
  return v > 0 ? pv / v : 0;
}

/**
 * Order Book Imbalance from a flat price array.
 * Assumes interleaved [bid0, ask0, bid1, ask1, ...] format.
 */
function calcOBI(prices: number[]): number {
  let bidVol = 0;
  let askVol = 0;
  for (let i = 0; i < prices.length; i += 2) {
    bidVol += prices[i]     ?? 0;
    askVol += prices[i + 1] ?? 0;
  }
  const total = bidVol + askVol;
  return total > 0 ? bidVol / total : 0.5;
}

/**
 * Full feature vector for ML inference (Phase 2).
 * Returns: [atr, vwap, obi, momentum5, momentum10, volatilityRatio]
 */
function calcFeatureVector(prices: number[], volumes: number[], period: number): number[] {
  const atr  = calcATR(prices, period);
  const vwap = calcVWAP(prices, volumes);
  const obi  = calcOBI(volumes);

  const n   = prices.length;
  const mom5  = n >= 5  ? prices[n - 1] - prices[n - 5]  : 0;
  const mom10 = n >= 10 ? prices[n - 1] - prices[n - 10] : 0;

  const mid = prices[n - 1] ?? 0;
  const volatilityRatio = mid > 0 ? atr / mid : 0;

  return [atr, vwap, obi, mom5, mom10, volatilityRatio];
}
