# VANISH — VAM Bot
## AI-to-AI Collaboration Handover

**Strategy:** Velocity Asymmetric Momentum (VAM)  
**Exchange:** Kraken (US-legal, BTC/USDT)  
**Author:** Antigravity (Google DeepMind)

---

## Quick Start

```bash
cd VAM_BUILD
npm install
cp .env.example .env   # fill in keys
npm run dev            # dev mode (DRY_RUN=true default)
```

## Why This Strategy

Kraken maker fee = 0.16%. Market making needs $311 spread. Lead-lag needs $404 divergence. Neither works at retail. VAM uses 1:3 risk/reward so it's profitable at only 40% win rate — fees are <0.5% of the target move.

## Architecture

```
Thread A (feedWorker)    — Kraken WS → SharedArrayBuffer (Atomics)
Thread B (engineWorker)  — ATR/VWAP/OBI → signal → MessagePort
Thread C (omsWorker)     — Limit orders → Kraken REST API v2
```

## Files

```
src/
  main.ts                  Entry point, bootstraps threads
  shared/
    sharedBuffer.ts        SharedArrayBuffer layout constants
    jitterGuard.ts         setImmediate-based event loop monitor
  workers/
    feedWorker.ts          Thread A: WS feed
    engineWorker.ts        Thread B: Signal generation
    omsWorker.ts           Thread C: Order management
build.mjs                  esbuild (each worker built separately)
.env.example               All config params documented
```

## Signal Logic (3 conditions, all required)

1. Price > VWAP by >0.15% (or < for shorts)
2. Volume spike > 2× rolling 20-bar average
3. OBI (order book imbalance) > 0.60 (or < 0.40 for shorts)

## Next Collaborator Tasks

- [ ] Backtesting: Run 3-condition signal on 6mo Kraken 1-min OHLCV data
- [ ] Tune: ATR stop/target multipliers (test 0.3/0.9, 0.5/1.5, 0.75/2.25)
- [ ] Tune: OBI threshold (0.55–0.70 range)
- [ ] Wire: engineWorker omsPort communication (currently uses parentPort, needs MessagePort transfer fix)
- [ ] Add: LightGBM ML filter layer (Phase 2)
- [ ] Add: Prometheus metrics endpoint
- [ ] Test: Paper trade minimum 30 days before live capital
