import 'dotenv/config';
import https from 'https';
import fs from 'fs';

const TOP_COINS = ['XBTUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'ADAUSD', 'AVAXUSD', 'LINKUSD', 'DOTUSD', 'MATICUSD', 'LTCUSD'];
const ACCOUNT_BALANCE = 5000;
const RISK_PER_TRADE = 0.01;
const MAKER_FEE = 0.0016;

interface Candle { time: number; open: number; high: number; low: number; close: number; vwap: number; volume: number; }

function fetchOHLCV(pair: string, since: number): Promise<Candle[]> {
  return new Promise((resolve, reject) => {
    https.get(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=5&since=${since}`, (res) => {
      let body = '';
      res.on('data', c => body += c.toString());
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error?.length) { reject(new Error(json.error.join(', '))); return; }
          const keys = Object.keys(json.result).filter(k => k !== 'last');
          const raw = json.result[keys[0]] as unknown[][];
          resolve(raw.map((r) => ({
            time: Number(r[0]) * 1000,
            open: parseFloat(r[1] as string),
            high: parseFloat(r[2] as string),
            low: parseFloat(r[3] as string),
            close: parseFloat(r[4] as string),
            vwap: parseFloat(r[5] as string),
            volume: parseFloat(r[6] as string),
          })));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchAllData(symbol: string, days: number): Promise<Candle[]> {
  const sinceSeconds = Math.floor((Date.now() - days * 86400_000) / 1000);
  let allCandles: Candle[] = [];
  let since = sinceSeconds;
  while (true) {
    const candles = await fetchOHLCV(symbol, since).catch(() => []);
    if (candles.length === 0) break;
    allCandles = allCandles.concat(candles);
    since = Math.floor(candles[candles.length - 1].time / 1000) + 1;
    await new Promise(r => setTimeout(r, 1100)); // Rate limit
    if (candles.length < 700) break;
  }
  return allCandles;
}

function simulate(candles: Candle[], p: any) {
  let balance = ACCOUNT_BALANCE;
  let position: 'long' | 'short' | 'flat' = 'flat';
  let entryPrice = 0; let stopPrice = 0; let targetPrice = 0;
  let tradeAtr = 0; let tradeQty = 0; let peakPrice = 0; let trailingActive = false;
  
  let atr = 0; let prevClose = 0; let atrCount = 0;
  const trBuf = new Array(p.atrPeriod).fill(0);
  const vwapPrices: number[] = []; const vwapVolumes: number[] = [];
  const volBuf: number[] = [];
  
  let totalPnl = 0; let wins = 0; let trades = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const mid = (c.high + c.low) / 2;

    if (prevClose > 0) {
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      if (atrCount < p.atrPeriod) { trBuf[atrCount] = tr; atrCount++; if (atrCount === p.atrPeriod) atr = trBuf.reduce((a, b) => a + b, 0) / p.atrPeriod; }
      else { atr = (atr * (p.atrPeriod - 1) + tr) / p.atrPeriod; }
    }
    prevClose = c.close;

    vwapPrices.push(c.vwap > 0 ? c.vwap : mid); vwapVolumes.push(c.volume);
    if (vwapPrices.length > 20) { vwapPrices.shift(); vwapVolumes.shift(); }
    let vwapPV = 0, vwapV = 0;
    for (let j = 0; j < vwapPrices.length; j++) { vwapPV += vwapPrices[j] * vwapVolumes[j]; vwapV += vwapVolumes[j]; }
    const vwap = vwapV > 0 ? vwapPV / vwapV : mid;

    volBuf.push(c.volume); if (volBuf.length > 20) volBuf.shift();
    const avgVol = volBuf.reduce((a, b) => a + b, 0) / volBuf.length;

    const pricePosition = vwap > 0 ? (c.close - vwap) / vwap : 0;
    const obi = 0.5 + Math.min(0.25, Math.max(-0.25, pricePosition * 20));

    if (position !== 'flat') {
      const checkPrice = position === 'long' ? c.low : c.high;
      const bestPrice = position === 'long' ? c.high : c.low;

      if (position === 'long') {
        if (bestPrice > peakPrice) peakPrice = bestPrice;
        if (!trailingActive && bestPrice >= entryPrice + tradeAtr) { trailingActive = true; stopPrice = entryPrice; }
        if (trailingActive) { const ts = peakPrice - tradeAtr; if (ts > stopPrice) stopPrice = ts; }
      } else {
        if (bestPrice < peakPrice) peakPrice = bestPrice;
        if (!trailingActive && bestPrice <= entryPrice - tradeAtr) { trailingActive = true; stopPrice = entryPrice; }
        if (trailingActive) { const ts = peakPrice + tradeAtr; if (ts < stopPrice) stopPrice = ts; }
      }

      const hitTarget = position === 'long' ? bestPrice >= targetPrice : bestPrice <= targetPrice;
      const hitStop = position === 'long' ? checkPrice <= stopPrice : checkPrice >= stopPrice;

      if (hitTarget || hitStop) {
        const exitPrice = hitTarget ? targetPrice : stopPrice;
        const rawPnl = position === 'long' ? (exitPrice - entryPrice) * tradeQty : (entryPrice - exitPrice) * tradeQty;
        const fees = (exitPrice * tradeQty * MAKER_FEE) + (entryPrice * tradeQty * MAKER_FEE);
        const netPnl = rawPnl - fees;

        balance += netPnl; totalPnl += netPnl; trades++;
        if (netPnl > 0) wins++;
        position = 'flat';
      }
      continue;
    }

    if (atr === 0 || i < p.atrPeriod + 20) continue;
    if (new Date(c.time).getUTCHours() < 6) continue;
    if (atr / mid < p.dormantThresh) continue;
    if (atr < (2 * MAKER_FEE * mid) / p.targetMult) continue;
    if (c.volume < avgVol * p.volSpikeMult) continue;

    const dist = (mid - vwap) / vwap;
    let signal = null;
    if (dist > p.vwapBreak && obi > p.obiLong) signal = 'long';
    if (dist < -p.vwapBreak && obi < p.obiShort) signal = 'short';

    if (signal) {
      const stopDist = atr * p.stopMult;
      const qty = (balance * RISK_PER_TRADE) / stopDist;
      position = signal as 'long'|'short';
      entryPrice = mid;
      tradeAtr = atr;
      tradeQty = parseFloat(qty.toFixed(8));
      trailingActive = false; peakPrice = mid;
      stopPrice = signal === 'long' ? mid - stopDist : mid + stopDist;
      targetPrice = signal === 'long' ? mid + atr * p.targetMult : mid - atr * p.targetMult;
    }
  }
  return { netPnl: totalPnl, trades, winRate: trades > 0 ? (wins/trades*100).toFixed(1) : '0.0' };
}

async function runAll() {
  console.log('='.repeat(60));
  console.log('🤖 GENERATING PRESETS FOR TOP MAJOR COINS');
  console.log('='.repeat(60));
  
  let presets: Record<string, any> = {};
  try {
    presets = JSON.parse(fs.readFileSync('presets.json', 'utf8'));
  } catch (e) {
    // start fresh if file doesn't exist
  }

  const stopMults = [0.5, 1.0, 1.5, 2.0];
  const targetMults = [1.5, 2.0, 3.0];
  const volSpikeMults = [2.0, 3.0, 4.0];
  const vwapBreaks = [0.0015, 0.0030, 0.0050];
  const dormantThreshs = [0.001, 0.003, 0.005]; // slightly lower dormant threshold for majors

  for (const symbol of TOP_COINS) {
    console.log(`\nAnalyzing ${symbol}... fetching data...`);
    const candles = await fetchAllData(symbol, 30);
    
    if (candles.length < 500) {
      console.log(`  [!] Skipping ${symbol} - not enough historical data on Kraken.`);
      continue;
    }

    let bestResult: any = { netPnl: -999999 };

    for (const stopMult of stopMults) {
      for (const targetMult of targetMults) {
        for (const volSpikeMult of volSpikeMults) {
          for (const vwapBreak of vwapBreaks) {
            for (const dormantThresh of dormantThreshs) {
              const params = { atrPeriod: 14, stopMult, targetMult, volSpikeMult, vwapBreak, dormantThresh, obiLong: 0.60, obiShort: 0.40 };
              const res = simulate(candles, params);
              // Require ≥3 trades for statistical significance
              if (res.trades >= 3 && res.netPnl > bestResult.netPnl) {
                bestResult = { ...res, params };
              }
            }
          }
        }
      }
    }

    if (bestResult.netPnl > -999999) {
      console.log(`  ✅ Best Setup Found for ${symbol}! Net PnL: $${bestResult.netPnl.toFixed(2)} (Win Rate: ${bestResult.winRate}%)`);
      presets[symbol] = {
        expectedPnl: bestResult.netPnl,
        winRate: bestResult.winRate,
        totalTrades: bestResult.trades,
        settings: {
          STOP_ATR_MULT: bestResult.params.stopMult,
          TARGET_ATR_MULT: bestResult.params.targetMult,
          VOLUME_SPIKE_MULTIPLIER: bestResult.params.volSpikeMult,
          VWAP_BREAK_MIN: bestResult.params.vwapBreak,
          ATR_DORMANT_THRESHOLD: bestResult.params.dormantThresh
        }
      };
    } else {
      console.log(`  ❌ No profitable setups found for ${symbol} with current constraints.`);
    }
  }

  fs.writeFileSync('presets.json', JSON.stringify(presets, null, 2));
  console.log('\n============================================================');
  console.log('🎉 ALL DONE! Saved top configurations to presets.json');
  console.log('============================================================\n');
}

runAll().catch(console.error);
