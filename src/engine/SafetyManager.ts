/**
 * SafetyManager — Circuit breaker for the VAM bot.
 *
 * Monitors realized P&L and triggers system state changes:
 *   HEALTHY       — normal operation
 *   WARNING       — 50% of max drawdown reached, reduce risk
 *   EMERGENCY_STOP — max drawdown hit, halt all trading immediately
 */

export enum SystemState {
  HEALTHY,
  WARNING,
  EMERGENCY_STOP,
}

export class CircuitBreaker {
  private readonly maxDrawdown: number;
  private readonly warnThreshold: number;
  private peakPnl: number = 0;

  constructor(maxDrawdownUsd: number = 500) {
    this.maxDrawdown   = maxDrawdownUsd;
    this.warnThreshold = maxDrawdownUsd * 0.5; // warn at 50% of max
  }

  /**
   * Call after every closed trade with the cumulative realized P&L.
   * Returns the current system state.
   */
  public checkHealth(cumulativePnl: number): SystemState {
    // Track peak so drawdown is measured from the highest point
    if (cumulativePnl > this.peakPnl) {
      this.peakPnl = cumulativePnl;
    }

    const drawdown = this.peakPnl - cumulativePnl;

    if (drawdown >= this.maxDrawdown) {
      console.error(
        `[SAFETY] EMERGENCY STOP — Drawdown $${drawdown.toFixed(2)} exceeded limit $${this.maxDrawdown}`
      );
      return SystemState.EMERGENCY_STOP;
    }

    if (drawdown >= this.warnThreshold) {
      console.warn(
        `[SAFETY] WARNING — Drawdown $${drawdown.toFixed(2)} (${((drawdown / this.maxDrawdown) * 100).toFixed(0)}% of limit)`
      );
      return SystemState.WARNING;
    }

    return SystemState.HEALTHY;
  }

  /** Current drawdown from peak (USD). */
  public getDrawdown(cumulativePnl: number): number {
    return Math.max(0, this.peakPnl - cumulativePnl);
  }

  /** Reset peak — call at start of each trading day. */
  public resetPeak(): void {
    this.peakPnl = 0;
  }
}
