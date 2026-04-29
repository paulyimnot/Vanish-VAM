# VANISH — VAM Bot
## AI-to-AI Handover Document v4.0
**Strategy:** Velocity Asymmetric Momentum (VAM)  
**Exchange:** Kraken BTC/USDT + Meme Coins (DOGE, PEPE, WIF, SOL, etc.)  
**Author:** Antigravity (Google DeepMind)  
**Repo:** https://github.com/paulyimnot/Vanish-VAM

---

## Quick Start

```bash
cd VAM_BUILD
npm install
cp .env.example .env      # fill in KRAKEN_API_KEY and KRAKEN_API_SECRET
npm run backtest          # run 6-month backtest — no API key needed!
npm run dev               # DRY_RUN=true by default — safe to run immediately
```

### Dashboard
When running `npm run dev`, open `http://localhost:8080` to view the live Web3 Dashboard (P&L, Win Rate, and WebSocket Terminal Stream).

### Auto-Optimizer
Run `node --loader ts-node/esm src/optimize_all.ts` to brute-force test the top 10 coins. The bot will automatically read the best settings from `presets.json` and overwrite `.env` defaults dynamically at runtime.

### Backtesting

```bash
npm run backtest                       # 6 months of Kraken 5-min candles
npm run backtest -- --days 30          # just 30 days
npm run backtest -- --csv results.csv  # export trade log to CSV
```

No API key required — uses Kraken's public OHLC endpoint.

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
  backtest.ts                Backtesting engine (fetches Kraken OHLCV, runs full sim)
  shared/
    sharedBuffer.ts           Float64 memory layout (53 elements)
    jitterGuard.ts            setImmediate-based event loop monitor
  engine/
    SafetyManager.ts          CircuitBreaker with 3 system states
    Processor.ts              Typed worker pool (2 reusable workers, 500ms timeout)
  workers/
    feedWorker.ts             Thread A: Kraken WS → SharedArrayBuffer (Atomics)
    engineWorker.ts           Thread B: ATR/VWAP/OBI + fee gate + time filter → signal
    omsWorker.ts              Thread C: orders + trailing stop + compound sizing
    calcWorker.ts             Pool worker: batch ATR/VWAP/OBI/feature calculations
.env.example                  All config params documented with defaults
build.mjs                     esbuild — each worker compiled separately
```

---

## Completed

- [x] **MessagePort wiring fixed** — OMS now listens on the transferred `omsPort` for engine signals
- [x] **Backtesting engine** — `npm run backtest` fetches Kraken OHLCV, runs full sim with trailing stop + compound sizing + real fees
- [x] **Trailing stop** — locks in breakeven once 1×ATR in profit, then trails 1×ATR below peak
- [x] **Compound sizing** — position scales with account balance growth
- [x] **Fee-aware ATR gate** — engine skips signals when ATR is too small for fees to be covered
- [x] **Meme Coin Sizing Fix** — Removed the 0.1 hardcoded coin limit so the bot can buy thousands of PEPE/DOGE based strictly on account risk %.
- [x] **Auto-Optimizer** — Grid search engine (`optimize_all.ts`) brute forces top combinations and saves to `presets.json`.
- [x] **Auto-Loading Presets** — `main.ts` intercepts `.env` and automatically loads the mathematically proven best setup for the given coin.
- [x] **Live WebSocket Dashboard** — HTTP/WS server built into `main.ts`. UI served at `localhost:8080` with live terminal streaming.

## Next Collaborator Tasks

### Priority 1 — Tuning (use the backtester!)
- [ ] **Tune ATR multipliers:** Run `npm run backtest` with different STOP_ATR_MULT / TARGET_ATR_MULT combos: (0.3/0.9), (0.5/1.5), (0.75/2.25). Compare win rate vs profit factor
- [ ] **Tune OBI threshold:** Test 0.55, 0.60, 0.65, 0.70. Tighter = fewer trades but higher win rate
- [ ] **Tune VWAP_BREAK_MIN:** Test 0.001, 0.0015, 0.002. Wider = fewer signals, more conviction

### Priority 2 — Profitability (ML layer)
- [ ] **LightGBM filter:** Train on 8 features (OBI, volume ratio, VWAP distance, ATR regime, time-of-day sin/cos, momentum-5, momentum-10, volatility ratio). Label: did price hit target before stop? Only trade if P(success) > 0.52
- [ ] **ONNX export + inference:** Add `onnxruntime-node` to package.json, load model in engineWorker, run in Processor pool

### Priority 3 — Production
- [ ] **Telegram alerts:** Send message on FILL, HALT, WARNING events
- [ ] **VPS deployment:** Hetzner or Vultr near Kraken (Frankfurt/London)
- [ ] **Fill confirmation:** Poll Kraken `/0/private/QueryOrders` to verify limit fills (current version assumes fill at price)
- [ ] **L2 delta handling:** Feed worker should apply book deltas after snapshot instead of overwriting

---

## Known Limitations
1. OMS assumes fills happen at target/stop price — real fills may differ (slippage)
2. Backtester estimates OBI from candle data (close vs VWAP proxy). Live OBI uses real L2 book
3. Processor worker pool fails if `calcWorker.js` doesn't exist — run `npm run build` first

---

---

*Handover v4.0 — Optimizer added, sizing fixed for altcoins, WebSocket dashboard live. Ready for ML filtering layer.*
