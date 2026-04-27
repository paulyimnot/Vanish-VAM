# VANISH — VAM Bot
## AI-to-AI Handover Document v2.0
**Strategy:** Velocity Asymmetric Momentum (VAM)  
**Exchange:** Kraken BTC/USDT (fully US-legal)  
**Author:** Antigravity (Google DeepMind)  
**Repo:** https://github.com/paulyimnot/Vanish-VAM

---

## Quick Start

```bash
cd VAM_BUILD
npm install
cp .env.example .env      # fill in KRAKEN_API_KEY and KRAKEN_API_SECRET
npm run dev               # DRY_RUN=true by default — safe to run immediately
```

On start you'll see:
```
============================================================
  VANISH — Velocity Asymmetric Momentum Bot v2
============================================================
  Symbol:         BTC/USDT
  Account:        $5000
  Risk/trade:     1.0% of balance
  R:R ratio:      1:3
  Maker fee:      0.16%
  ATR breakeven:  ~$166 per BTC (fees covered at this ATR)
  DryRun:         true
  Trading hours:  06:00–24:00 UTC
============================================================
```

---

## Why This Strategy (For Next Collaborator)

Kraken charges 0.16% maker fee. Market making needs $311 spread. Lead-lag needs $404 divergence. Both lose at retail.

VAM uses **1:3 risk/reward**. You can be wrong 60% of the time and still profit. Fees are <0.3% of the target move.

**Breakeven math:**
- Round-trip fees: `2 × 0.16% = 0.32%` of notional
- Target move: `1.5 × ATR` of BTC price
- Profitable when ATR > `(2 × 0.16% × price) / 1.5` ≈ **$166 at $78k BTC**
- BTC hits ATR > $166 during any moderate volatility (multiple times/day)

---

## Architecture

```
Thread A  feedWorker.ts      Kraken WS → SharedArrayBuffer (Atomics)
Thread B  engineWorker.ts    ATR / VWAP / OBI → Signal → MessagePort → OMS
Thread C  omsWorker.ts       Limit orders, trailing stop, compound sizing, circuit breaker
Pool      Processor.ts       Worker pool for heavy calcs (ATR batches, feature vectors)
Safety    SafetyManager.ts   Circuit breaker: HEALTHY / WARNING / EMERGENCY_STOP
```

---

## Signal Logic (All 3 required)

| Condition | Long | Short |
|---|---|---|
| VWAP breakout | Price > VWAP by >0.15% | Price < VWAP by >0.15% |
| Volume spike | Current bar > 2× 20-bar avg | Same |
| OBI | Bid pressure > 60% | Ask pressure > 60% |

**Additional gates:**
- ATR must be above fee breakeven (~$166 at current BTC price)
- Time filter: 06:00–24:00 UTC only (skips thin overnight session)
- Signal cooldown: 30 seconds between signals
- Signal staleness: OMS rejects signals older than 3 seconds

---

## Position Management

- **Entry:** Limit order 0.05% inside mid (always maker, 0.16% fee)
- **Stop:** 0.5 × ATR from entry
- **Target:** 1.5 × ATR from entry  
- **Trailing stop:** Activates once price moves 1×ATR in our favor → stop moves to breakeven, then trails 1×ATR below peak
- **Sizing:** Kelly lite — `(balance × 1%) / stopDistanceUSD` — grows as account grows
- **Circuit breaker:** Halts at $500 drawdown from peak (configurable)

---

## File Map

```
src/
  main.ts                    Entry point — wires 3 threads + jitter guard
  shared/
    sharedBuffer.ts           Float64 memory layout (53 elements)
    jitterGuard.ts            setImmediate-based event loop monitor
  engine/
    SafetyManager.ts          CircuitBreaker with 3 system states
    Processor.ts              Typed worker pool (2 reusable workers, 500ms timeout)
  workers/
    feedWorker.ts             Thread A: Kraken WS → SharedArrayBuffer
    engineWorker.ts           Thread B: ATR/VWAP/OBI → signal
    omsWorker.ts              Thread C: orders + trailing stop + compound sizing
    calcWorker.ts             Pool worker: batch ATR/VWAP/OBI/feature calculations
.env.example                  All config params documented with defaults
build.mjs                     esbuild — each worker compiled separately
```

---

## Next Collaborator Tasks

### Priority 1 — Must fix before live trading
- [ ] **Fix MessagePort wiring:** engineWorker sends signals via `omsPort` (MessageChannel) but omsWorker currently listens on `parentPort`. Need to pass the port correctly via `transferList` and listen on it in omsWorker
- [ ] **Backtesting:** Run 3-condition signal on 6 months Kraken 1-min OHLCV. Measure actual win rate, avg winner/loser
- [ ] **Tune ATR multipliers:** Test stop/target combos: (0.3/0.9), (0.5/1.5), (0.75/2.25) against backtest data

### Priority 2 — Profitability improvements
- [ ] **LightGBM ML filter:** Train on 8 features (OBI, volume ratio, VWAP distance, ATR regime, time-of-day sin/cos, momentum-5, momentum-10, volatility ratio). Label: did price hit 1.5×ATR before 0.5×ATR stop? Filter: only trade if P(success) > 0.52
- [ ] **ONNX export + inference:** Add `onnxruntime-node` to package.json, load model in engineWorker, run in Processor pool

### Priority 3 — Production readiness
- [ ] **Prometheus metrics:** `/metrics` endpoint with trade count, P&L, win rate, ATR, OBI
- [ ] **Telegram alerts:** Send message on FILL, HALT, WARNING events
- [ ] **VPS deployment:** Hetzner or Vultr, closest datacenter to Kraken (Frankfurt/London)
- [ ] **Fill confirmation:** Poll Kraken `/0/private/QueryOrders` to confirm limit order fills (current version assumes fill at target/stop price)

---

## Known Limitations
1. OMS assumes fills happen at target/stop price — real fills may differ (slippage)
2. The Processor worker pool initializes immediately on import — if calcWorker.js doesn't exist at startup, it will throw. Build first: `npm run build`
3. Kraken WebSocket v2 `book` channel sends delta updates after the initial snapshot — the feed worker currently overwrites rather than applying deltas properly for deeper levels

---

*Handover v2.0 — Ready for backtesting and ML filter implementation*
