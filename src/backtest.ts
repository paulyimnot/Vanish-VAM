/**
 * VAM Backtester — Run the strategy against historical Kraken OHLCV data.
 *
 * Usage:
 *   npm run backtest                      # fetch 6 months, run, print report
 *   npm run backtest -- --days 30         # just 30 days
 *   npm run backtest -- --csv results.csv # export trades to CSV
 *
 * Data source: Kraken public REST API (no API key needed).
 * Simulates: ATR, VWAP, OBI (estimated from candle data), trailing stop, compound sizing, real fees.
 */

import 'dotenv/config';
import https from 'https';
import fs from 'fs';

// ── Config (from .env or defaults) ──────────────────────────────────────────
const e = process.env;
const SYMBOL          = e['SYMBOL']                ?? 'XBTUSD'; // Kraken pair name for REST
const MAKER_FEE       = parseFloat(e['MAKER_FEE']  ?? '0.0016');
const ACCOUNT_BALANCE = parseFloat(e['ACCOUNT_BALANCE'] ?? '5000');
const RISK_PER_TRADE  = parseFloat(e['RISK_PER_TRADE']  ?? '0.01');
const ATR_PERIOD      = parseInt(e['ATR_PERIOD']        ?? '14', 10);
const DORMANT_THRESH  = parseFloat(e['ATR_DORMANT_THRESHOLD'] ?? '0.003');
const VOL_SPIKE_MULT  = parseFloat(e['VOLUME_SPIKE_MULTIPLIER'] ?? '2.0');
const OBI_LONG        = parseFloat(e['OBI_LONG_THRESHOLD']  ?? '0.60');
const OBI_SHORT       = parseFloat(e['OBI_SHORT_THRESHOLD'] ?? '0.40');
const VWAP_BREAK      = parseFloat(e['VWAP_BREAK_MIN']      ?? '0.0015');
const STOP_MULT       = parseFloat(e['STOP_ATR_MULT']       ?? '0.5');
const TARGET_MULT     = parseFloat(e['TARGET_ATR_MULT']      ?? '1.5');
const MAX_DAILY_LOSS  = parseFloat(e['MAX_DAILY_LOSS']       ?? '0.03');

const DAYS = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--days') ?? '180', 10);
const CSV_OUT = process.argv.find((_, i, a) => a[i - 1] === '--csv') ?? '';

// ── Types ───────────────────────────────────────────────────────────────────
interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number;
  volume: number;
}

interface Trade {
  entryTime: number;
  exitTime: number;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
  exitReason: 'target' | 'stop' | 'trailing';
}

// ── Fetch historical data from Kraken ────────────────────────────────────────
function fetchOHLCV(pair: string, since: number): Promise<Candle[]> {
  return new Promise((resolve, reject) => {
    const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=5&since=${since}`;
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          const json = JSON.parse(body) as { error: string[]; result: Record<string, unknown[][]> };
          if (json.error?.length) { reject(new Error(json.error.join(', '))); return; }
          const keys = Object.keys(json.result).filter(k => k !== 'last');
          const raw = json.result[keys[0]] as unknown[][];
          const candles: Candle[] = raw.map((r) => ({
            time:   Number(r[0]) * 1000,
            open:   parseFloat(r[1] as string),
            high:   parseFloat(r[2] as string),
            low:    parseFloat(r[3] as string),
            close:  parseFloat(r[4] as string),
            vwap:   parseFloat(r[5] as string),
            volume: parseFloat(r[6] as string),
          }));
          resolve(candles);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchAllData(): Promise<Candle[]> {
  const sinceSeconds = Math.floor((Date.now() - DAYS * 86400_000) / 1000);
  console.log(`Fetching ${DAYS} days of 5-min candles for ${SYMBOL}...`);

  // Kraken returns max 720 candles per request — paginate
  let allCandles: Candle[] = [];
  let since = sinceSeconds;
  let batch = 0;

  while (true) {
    const candles = await fetchOHLCV(SYMBOL, since);
    if (candles.length === 0) break;
    allCandles = allCandles.concat(candles);
    since = Math.floor(candles[candles.length - 1].time / 1000) + 1;
    batch++;
    process.stdout.write(`  Batch ${batch}: ${allCandles.length} candles total\r`);

    // Kraken rate limit — 1 req/sec for public
    await new Promise(r => setTimeout(r, 1100));

    // If we got less than 720, we're at the end
    if (candles.length < 700) break;
  }

  console.log(`\nFetched ${allCandles.length} candles (${(allCandles.length * 5 / 60 / 24).toFixed(1)} days)\n`);
  return allCandles;
}

// ── Backtest engine ──────────────────────────────────────────────────────────
function runBacktest(candles: Candle[]): Trade[] {
  const trades: Trade[] = [];

  // ATR state
  let atr = 0;
  let prevClose = 0;
  let atrCount = 0;
  const trBuf: number[] = new Array(ATR_PERIOD).fill(0);

  // VWAP state (rolling 20 bars)
  const VWAP_WINDOW = 20;
  const vwapPrices: number[] = [];
  const vwapVolumes: number[] = [];

  // Volume state
  const VOL_WINDOW = 20;
  const volBuf: number[] = [];

  // Position state
  let position: 'long' | 'short' | 'flat' = 'flat';
  let entryPrice = 0;
  let entryTime  = 0;
  let stopPrice  = 0;
  let targetPrice = 0;
  let tradeAtr   = 0;
  let tradeQty   = 0;
  let trailingActive = false;
  let peakPrice  = 0;

  let balance    = ACCOUNT_BALANCE;
  let dailyPnl   = 0;
  let lastDay    = -1;
  let halted     = false;
  let cooldownUntil = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const mid = (c.high + c.low) / 2;
    const dayOfYear = Math.floor(c.time / 86400_000);

    // Reset daily P&L
    if (dayOfYear !== lastDay) {
      dailyPnl = 0;
      lastDay = dayOfYear;
      halted = false;
    }

    // ── Update ATR ─────────────────────────────────────────────────────────
    if (prevClose > 0) {
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      if (atrCount < ATR_PERIOD) {
        trBuf[atrCount] = tr;
        atrCount++;
        if (atrCount === ATR_PERIOD) {
          atr = trBuf.reduce((a, b) => a + b, 0) / ATR_PERIOD;
        }
      } else {
        atr = (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
      }
    }
    prevClose = c.close;

    // ── Rolling VWAP ───────────────────────────────────────────────────────
    vwapPrices.push(c.vwap > 0 ? c.vwap : mid);
    vwapVolumes.push(c.volume);
    if (vwapPrices.length > VWAP_WINDOW) { vwapPrices.shift(); vwapVolumes.shift(); }
    let vwapPV = 0, vwapV = 0;
    for (let j = 0; j < vwapPrices.length; j++) { vwapPV += vwapPrices[j] * vwapVolumes[j]; vwapV += vwapVolumes[j]; }
    const vwap = vwapV > 0 ? vwapPV / vwapV : mid;

    // ── Volume buffer ──────────────────────────────────────────────────────
    volBuf.push(c.volume);
    if (volBuf.length > VOL_WINDOW) volBuf.shift();
    const avgVol = volBuf.reduce((a, b) => a + b, 0) / volBuf.length;

    // ── Simulate OBI from candle data ──────────────────────────────────────
    // Real OBI needs L2 book data. For backtesting, estimate from candle:
    // If close > vwap: buy pressure dominant → OBI > 0.5
    // If close < vwap: sell pressure → OBI < 0.5
    const pricePosition = vwap > 0 ? (c.close - vwap) / vwap : 0;
    const obi = 0.5 + Math.min(0.25, Math.max(-0.25, pricePosition * 20));

    // ── Monitor open position ──────────────────────────────────────────────
    if (position !== 'flat') {
      const checkPrice = position === 'long' ? c.low : c.high; // worst-case fill
      const bestPrice  = position === 'long' ? c.high : c.low;

      // Trailing stop
      if (position === 'long') {
        if (bestPrice > peakPrice) peakPrice = bestPrice;
        if (!trailingActive && bestPrice >= entryPrice + tradeAtr) {
          trailingActive = true;
          stopPrice = entryPrice;
        }
        if (trailingActive) {
          const ts = peakPrice - tradeAtr;
          if (ts > stopPrice) stopPrice = ts;
        }
      } else {
        if (bestPrice < peakPrice) peakPrice = bestPrice;
        if (!trailingActive && bestPrice <= entryPrice - tradeAtr) {
          trailingActive = true;
          stopPrice = entryPrice;
        }
        if (trailingActive) {
          const ts = peakPrice + tradeAtr;
          if (ts < stopPrice) stopPrice = ts;
        }
      }

      // Check target / stop
      const hitTarget = position === 'long' ? bestPrice >= targetPrice : bestPrice <= targetPrice;
      const hitStop   = position === 'long' ? checkPrice <= stopPrice  : checkPrice >= stopPrice;

      if (hitTarget || hitStop) {
        const exitPrice = hitTarget ? targetPrice : stopPrice;
        const rawPnl = position === 'long'
          ? (exitPrice - entryPrice) * tradeQty
          : (entryPrice - exitPrice) * tradeQty;
        const fees = (exitPrice * tradeQty * MAKER_FEE) + (entryPrice * tradeQty * MAKER_FEE);
        const netPnl = rawPnl - fees;

        trades.push({
          entryTime: entryTime,
          exitTime: c.time,
          side: position,
          entryPrice,
          exitPrice,
          qty: tradeQty,
          grossPnl: rawPnl,
          fees,
          netPnl,
          exitReason: hitTarget ? 'target' : (trailingActive ? 'trailing' : 'stop'),
        });

        balance += netPnl;
        dailyPnl += netPnl;
        position = 'flat';
        cooldownUntil = c.time + 5 * 60_000; // 5-min cooldown after exit

        if (dailyPnl / ACCOUNT_BALANCE <= -MAX_DAILY_LOSS) halted = true;
        continue;
      }
    }

    // ── Skip conditions ────────────────────────────────────────────────────
    if (position !== 'flat') continue;
    if (halted) continue;
    if (atr === 0) continue;
    if (i < ATR_PERIOD + VOL_WINDOW) continue; // warmup
    if (c.time < cooldownUntil) continue;

    const atrPct = atr / mid;
    if (atrPct < DORMANT_THRESH) continue;

    // Time filter: skip 00:00–06:00 UTC
    const hour = new Date(c.time).getUTCHours();
    if (hour < 6) continue;

    // Fee-aware ATR gate
    const minAtr = (2 * MAKER_FEE * mid) / TARGET_MULT;
    if (atr < minAtr) continue;

    // Volume spike
    if (c.volume < avgVol * VOL_SPIKE_MULT) continue;

    // VWAP breakout + OBI
    const dist = (mid - vwap) / vwap;

    let signal: 'long' | 'short' | null = null;
    if (dist > VWAP_BREAK && obi > OBI_LONG)  signal = 'long';
    if (dist < -VWAP_BREAK && obi < OBI_SHORT) signal = 'short';

    if (!signal) continue;

    // ── Open position ──────────────────────────────────────────────────────
    const stopDist = atr * STOP_MULT;
    const qty = Math.max(0.001, Math.min(0.1, (balance * RISK_PER_TRADE) / stopDist));

    position    = signal;
    entryPrice  = mid;
    entryTime   = c.time;
    tradeAtr    = atr;
    tradeQty    = parseFloat(qty.toFixed(4));
    trailingActive = false;
    peakPrice   = mid;

    if (signal === 'long') {
      stopPrice   = mid - stopDist;
      targetPrice = mid + atr * TARGET_MULT;
    } else {
      stopPrice   = mid + stopDist;
      targetPrice = mid - atr * TARGET_MULT;
    }
  }

  return trades;
}

// ── Report ───────────────────────────────────────────────────────────────────
function printReport(trades: Trade[]): void {
  if (trades.length === 0) {
    console.log('No trades generated. Try adjusting parameters or increasing timeframe.');
    return;
  }

  const wins   = trades.filter(t => t.netPnl >= 0);
  const losses = trades.filter(t => t.netPnl < 0);
  const totalPnl = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalFees = trades.reduce((s, t) => s + t.fees, 0);
  const avgWin  = wins.length > 0 ? wins.reduce((s, t) => s + t.netPnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPnl, 0) / losses.length : 0;
  const maxWin  = wins.length > 0 ? Math.max(...wins.map(t => t.netPnl)) : 0;
  const maxLoss = losses.length > 0 ? Math.min(...losses.map(t => t.netPnl)) : 0;

  // Max drawdown
  let peak = ACCOUNT_BALANCE;
  let maxDD = 0;
  let running = ACCOUNT_BALANCE;
  for (const t of trades) {
    running += t.netPnl;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe (daily returns)
  const dailyReturns: Map<number, number> = new Map();
  for (const t of trades) {
    const day = Math.floor(t.exitTime / 86400_000);
    dailyReturns.set(day, (dailyReturns.get(day) ?? 0) + t.netPnl);
  }
  const returns = Array.from(dailyReturns.values());
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length;
  const sharpe = variance > 0 ? (meanReturn / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  // Exit reasons
  const targets  = trades.filter(t => t.exitReason === 'target').length;
  const stops    = trades.filter(t => t.exitReason === 'stop').length;
  const trailing = trades.filter(t => t.exitReason === 'trailing').length;

  const firstDate = new Date(trades[0].entryTime).toISOString().split('T')[0];
  const lastDate  = new Date(trades[trades.length - 1].exitTime).toISOString().split('T')[0];

  console.log('='.repeat(60));
  console.log('  VANISH — VAM Backtest Results');
  console.log('='.repeat(60));
  console.log(`  Period:         ${firstDate} → ${lastDate}`);
  console.log(`  Starting:       $${ACCOUNT_BALANCE.toFixed(2)}`);
  console.log(`  Final:          $${(ACCOUNT_BALANCE + totalPnl).toFixed(2)}`);
  console.log(`  Net P&L:        ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${((totalPnl / ACCOUNT_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Total Fees:     $${totalFees.toFixed(2)}`);
  console.log('─'.repeat(60));
  console.log(`  Trades:         ${trades.length}`);
  console.log(`  Win Rate:       ${((wins.length / trades.length) * 100).toFixed(1)}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Avg Win:        +$${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:       $${avgLoss.toFixed(2)}`);
  console.log(`  Best Trade:     +$${maxWin.toFixed(2)}`);
  console.log(`  Worst Trade:    $${maxLoss.toFixed(2)}`);
  console.log(`  Profit Factor:  ${losses.length > 0 ? (wins.reduce((s, t) => s + t.netPnl, 0) / Math.abs(losses.reduce((s, t) => s + t.netPnl, 0))).toFixed(2) : '∞'}`);
  console.log('─'.repeat(60));
  console.log(`  Max Drawdown:   $${maxDD.toFixed(2)} (${((maxDD / ACCOUNT_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Sharpe Ratio:   ${sharpe.toFixed(2)} (annualized)`);
  console.log('─'.repeat(60));
  console.log(`  Exits:          🎯 Target: ${targets}  |  🛑 Stop: ${stops}  |  📈 Trailing: ${trailing}`);
  console.log(`  Maker Fee:      ${(MAKER_FEE * 100).toFixed(2)}%`);
  console.log(`  R:R Ratio:      1:${(TARGET_MULT / STOP_MULT).toFixed(0)}`);
  console.log('='.repeat(60));

  if (CSV_OUT) {
    const header = 'entryTime,exitTime,side,entryPrice,exitPrice,qty,grossPnl,fees,netPnl,exitReason\n';
    const rows = trades.map(t =>
      `${new Date(t.entryTime).toISOString()},${new Date(t.exitTime).toISOString()},${t.side},${t.entryPrice},${t.exitPrice},${t.qty},${t.grossPnl.toFixed(4)},${t.fees.toFixed(4)},${t.netPnl.toFixed(4)},${t.exitReason}`
    ).join('\n');
    fs.writeFileSync(CSV_OUT, header + rows);
    console.log(`\n📄 Trades exported to ${CSV_OUT}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('  VANISH — VAM Backtester');
  console.log('='.repeat(60));
  console.log(`  Pair:           ${SYMBOL}`);
  console.log(`  Days:           ${DAYS}`);
  console.log(`  Balance:        $${ACCOUNT_BALANCE}`);
  console.log(`  Risk/Trade:     ${(RISK_PER_TRADE * 100).toFixed(1)}%`);
  console.log(`  R:R:            1:${(TARGET_MULT / STOP_MULT).toFixed(0)}`);
  console.log(`  Fee:            ${(MAKER_FEE * 100).toFixed(2)}%`);
  console.log('='.repeat(60) + '\n');

  const candles = await fetchAllData();
  if (candles.length < ATR_PERIOD + 20) {
    console.error('Not enough data for backtest. Try increasing --days.');
    process.exit(1);
  }

  console.log('Running backtest...\n');
  const trades = runBacktest(candles);
  printReport(trades);
}

main().catch(console.error);
