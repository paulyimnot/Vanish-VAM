// src/workers/calcWorker.ts
import { parentPort } from "worker_threads";
if (!parentPort) throw new Error("calcWorker must run as a Worker thread");
parentPort.on("message", (input) => {
  const start = performance.now();
  let result;
  switch (input.type) {
    case "atr":
      result = calcATR(input.prices, input.period ?? 14);
      break;
    case "vwap":
      result = calcVWAP(input.prices, input.volumes ?? []);
      break;
    case "obi":
      result = calcOBI(input.prices);
      break;
    case "features":
      result = calcFeatureVector(input.prices, input.volumes ?? [], input.period ?? 14);
      break;
    default: {
      const _exhaustive = input.type;
      result = 0;
    }
  }
  const output = {
    type: input.type,
    result,
    durationMs: performance.now() - start
  };
  parentPort.postMessage(output);
});
function calcATR(prices, period) {
  if (prices.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < prices.length; i++) {
    trs.push(Math.abs(prices[i] - prices[i - 1]));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}
function calcVWAP(prices, volumes) {
  if (prices.length === 0 || prices.length !== volumes.length) return 0;
  let pv = 0;
  let v = 0;
  for (let i = 0; i < prices.length; i++) {
    pv += prices[i] * volumes[i];
    v += volumes[i];
  }
  return v > 0 ? pv / v : 0;
}
function calcOBI(prices) {
  let bidVol = 0;
  let askVol = 0;
  for (let i = 0; i < prices.length; i += 2) {
    bidVol += prices[i] ?? 0;
    askVol += prices[i + 1] ?? 0;
  }
  const total = bidVol + askVol;
  return total > 0 ? bidVol / total : 0.5;
}
function calcFeatureVector(prices, volumes, period) {
  const atr = calcATR(prices, period);
  const vwap = calcVWAP(prices, volumes);
  const obi = calcOBI(volumes);
  const n = prices.length;
  const mom5 = n >= 5 ? prices[n - 1] - prices[n - 5] : 0;
  const mom10 = n >= 10 ? prices[n - 1] - prices[n - 10] : 0;
  const mid = prices[n - 1] ?? 0;
  const volatilityRatio = mid > 0 ? atr / mid : 0;
  return [atr, vwap, obi, mom5, mom10, volatilityRatio];
}
