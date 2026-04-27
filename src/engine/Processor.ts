/**
 * Processor — Typed worker pool for heavy off-thread calculations.
 *
 * Instead of spawning a new Worker per call (expensive), this maintains
 * a pool of reusable workers. Each call checks out an idle worker,
 * runs the calculation, then returns the worker to the pool.
 *
 * Used for: batch ATR calculations, feature engineering, future ML inference.
 */

import { Worker, workerData as _w } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Typed interfaces ──────────────────────────────────────────────────────────

export interface CalcInput {
  type: 'atr' | 'vwap' | 'obi' | 'features';
  prices: number[];
  volumes?: number[];
  period?: number;
}

export interface CalcOutput {
  type: CalcInput['type'];
  result: number | number[];
  durationMs: number;
}

// ── Worker pool ───────────────────────────────────────────────────────────────

interface PooledWorker {
  worker: Worker;
  busy: boolean;
}

const WORKER_PATH = path.resolve(__dirname, '../workers/calcWorker.js');
const POOL_SIZE   = 2;   // 2 is enough for our calculation load
const TIMEOUT_MS  = 500; // 500ms max — HFT can't wait longer

const _pool: PooledWorker[] = Array.from({ length: POOL_SIZE }, () => ({
  worker: new Worker(WORKER_PATH),
  busy:   false,
}));

function _getIdleWorker(): PooledWorker | null {
  return _pool.find((w) => !w.busy) ?? null;
}

/**
 * Run a heavy calculation on an off-thread worker.
 * Rejects if no worker is idle or if the calculation times out.
 */
export function runCalculation(input: CalcInput): Promise<CalcOutput> {
  return new Promise((resolve, reject) => {
    const pooled = _getIdleWorker();
    if (!pooled) {
      reject(new Error('No idle workers available in pool — all busy'));
      return;
    }

    pooled.busy = true;

    const timeout = setTimeout(() => {
      pooled.busy = false;
      reject(new Error(`Calculation timeout after ${TIMEOUT_MS}ms (type: ${input.type})`));
    }, TIMEOUT_MS);

    const onMessage = (output: CalcOutput): void => {
      clearTimeout(timeout);
      pooled.busy = false;
      pooled.worker.off('message', onMessage);
      pooled.worker.off('error',   onError);
      resolve(output);
    };

    const onError = (err: Error): void => {
      clearTimeout(timeout);
      pooled.busy = false;
      pooled.worker.off('message', onMessage);
      pooled.worker.off('error',   onError);
      reject(err);
    };

    pooled.worker.on('message', onMessage);
    pooled.worker.on('error',   onError);
    pooled.worker.postMessage(input);
  });
}

/** Cleanly terminate all pooled workers. Call on shutdown. */
export async function shutdownPool(): Promise<void> {
  await Promise.all(_pool.map((w) => w.worker.terminate()));
}
