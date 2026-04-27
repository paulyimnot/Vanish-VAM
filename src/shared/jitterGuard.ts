/**
 * Jitter Guard — monitors Node.js event loop lag.
 * Uses setImmediate (not setInterval!) to ride the actual event loop tick.
 * setInterval is WRONG for this: it fires at ~2-15ms regardless of lag.
 */

import { performance } from 'perf_hooks';

let _lastTick = performance.now();

/**
 * Start the jitter guard loop.
 * @param maxLagMs  Kill switch fires if lag exceeds this (ms). Default: 5ms.
 * @param onKill    Called with reason string when lag is exceeded.
 */
export function startJitterGuard(
  maxLagMs: number,
  onKill: (reason: string) => void
): void {
  const check = (): void => {
    const now = performance.now();
    const lagMs = now - _lastTick;
    _lastTick = now;

    if (lagMs > maxLagMs) {
      onKill(`Event loop lag: ${lagMs.toFixed(2)}ms (max: ${maxLagMs}ms)`);
    }

    setImmediate(check); // self-scheduling — rides real event loop, not timer
  };

  setImmediate(check);
}
