// src/main.ts
import "dotenv/config";
import fs from "fs";
import http from "http";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Worker, MessageChannel, isMainThread } from "worker_threads";

// src/shared/sharedBuffer.ts
var DEPTH = 10;
var BID_QTYS_START = 5 + DEPTH;
var ASK_PRICES_START = 5 + DEPTH * 2;
var ASK_QTYS_START = 5 + DEPTH * 3;
var ATR = 5 + DEPTH * 4;
var VWAP = ATR + 1;
var OBI = ATR + 2;
var SIGNAL = ATR + 3;
var SIGNAL_PRICE = ATR + 4;
var SIGNAL_ATR = ATR + 5;
var REGIME_SCORE = ATR + 6;
var VWAP_VOL = ATR + 7;
var TOTAL_ELEMENTS = ATR + 8;
var BUFFER_BYTES = TOTAL_ELEMENTS * Float64Array.BYTES_PER_ELEMENT;

// src/shared/jitterGuard.ts
import { performance } from "perf_hooks";
var _lastTick = performance.now();
function startJitterGuard(maxLagMs, onKill) {
  const check = () => {
    const now = performance.now();
    const lagMs = now - _lastTick;
    _lastTick = now;
    if (lagMs > maxLagMs) {
      onKill(`Event loop lag: ${lagMs.toFixed(2)}ms (max: ${maxLagMs}ms)`);
    }
    setImmediate(check);
  };
  setImmediate(check);
}

// src/main.ts
if (!isMainThread) throw new Error("main.ts must run on main thread");
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var e = process.env;
var makerFee = parseFloat(e["MAKER_FEE"] ?? "0.0016");
var riskPerTrade = parseFloat(e["RISK_PER_TRADE"] ?? "0.01");
var stopAtrMult = parseFloat(e["STOP_ATR_MULT"] ?? "0.5");
var targetAtrMult = parseFloat(e["TARGET_ATR_MULT"] ?? "1.5");
var accountBalance = parseFloat(e["ACCOUNT_BALANCE"] ?? "5000");
var symbol = e["SYMBOL"] ?? "BTC/USDT";
var p = {};
try {
  const presets = JSON.parse(fs.readFileSync(new URL("../presets.json", import.meta.url), "utf8"));
  const presetKey = symbol.replace("/", "");
  if (presets[presetKey]) {
    p = presets[presetKey].settings;
    console.log(`
[VANISH] \u26A1 Auto-loaded optimized preset for ${symbol}
`);
  }
} catch (err) {
}
var cfg = {
  apiKey: e["KRAKEN_API_KEY"] ?? "",
  apiSecret: e["KRAKEN_API_SECRET"] ?? "",
  symbol,
  accountBalance,
  riskPerTrade,
  makerFee,
  stopAtrMult: p["STOP_ATR_MULT"] ?? stopAtrMult,
  targetAtrMult: p["TARGET_ATR_MULT"] ?? targetAtrMult,
  atrPeriod: parseInt(e["ATR_PERIOD"] ?? "14", 10),
  dormantThreshold: p["ATR_DORMANT_THRESHOLD"] ?? parseFloat(e["ATR_DORMANT_THRESHOLD"] ?? "0.003"),
  volatileThreshold: parseFloat(e["ATR_VOLATILE_THRESHOLD"] ?? "0.02"),
  volumeSpikeMultiplier: p["VOLUME_SPIKE_MULTIPLIER"] ?? parseFloat(e["VOLUME_SPIKE_MULTIPLIER"] ?? "2.0"),
  obiLongThreshold: parseFloat(e["OBI_LONG_THRESHOLD"] ?? "0.60"),
  obiShortThreshold: parseFloat(e["OBI_SHORT_THRESHOLD"] ?? "0.40"),
  vwapBreakMin: p["VWAP_BREAK_MIN"] ?? parseFloat(e["VWAP_BREAK_MIN"] ?? "0.0015"),
  maxDailyLossRate: parseFloat(e["MAX_DAILY_LOSS"] ?? "0.03"),
  maxDrawdownUsd: parseFloat(e["MAX_DRAWDOWN_USD"] ?? "500"),
  dryRun: e["DRY_RUN"] !== "false"
};
if (!cfg.dryRun && (!cfg.apiKey || !cfg.apiSecret)) {
  console.error("[VANISH] ERROR: KRAKEN_API_KEY and KRAKEN_API_SECRET required for live trading.");
  process.exit(1);
}
var breakeven = (2 * makerFee * 78e3 / targetAtrMult).toFixed(0);
console.log("=".repeat(60));
console.log("  VANISH \u2014 Velocity Asymmetric Momentum Bot v2");
console.log("=".repeat(60));
console.log(`  Symbol:         ${cfg.symbol}`);
console.log(`  Account:        $${accountBalance}`);
console.log(`  Risk/trade:     ${(riskPerTrade * 100).toFixed(1)}% of balance`);
console.log(`  R:R ratio:      1:${targetAtrMult / stopAtrMult}`);
console.log(`  Maker fee:      ${(makerFee * 100).toFixed(2)}%`);
console.log(`  ATR breakeven:  ~$${breakeven} per BTC (fees covered at this ATR)`);
console.log(`  DryRun:         ${cfg.dryRun}`);
console.log(`  Trading hours:  06:00\u201324:00 UTC (skips thin overnight session)`);
console.log("=".repeat(60));
var stats = { pnl: 0, wins: 0, losses: 0, balance: accountBalance };
var server = http.createServer((req, res) => {
  if (req.url === "/") {
    fs.readFile(join(__dirname, "../public/index.html"), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Error loading index.html");
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});
var wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "init", dryRun: cfg.dryRun, symbol: cfg.symbol, balance: accountBalance }));
  ws.send(JSON.stringify({ type: "stats", ...stats }));
});
var DASHBOARD_PORT = parseInt(process.env["PORT"] ?? "8080", 10);
server.listen(DASHBOARD_PORT, () => {
  console.log(`
[DASHBOARD] \u{1F310} Live at http://localhost:${DASHBOARD_PORT}
`);
});
function broadcastLog(msg) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(JSON.stringify({ type: "log", msg }));
  });
}
var sharedBuffer = new SharedArrayBuffer(BUFFER_BYTES);
var { port1: enginePort, port2: omsPort } = new MessageChannel();
var feedWorker = new Worker(
  new URL("./workers/feedWorker.js", import.meta.url),
  { workerData: { sharedBuffer, symbol: cfg.symbol } }
);
feedWorker.on("message", (m) => {
  const s = `[FEED]   ${m.msg}`;
  console.log(s);
  broadcastLog(s);
});
feedWorker.on("error", (err) => console.error("[FEED ERROR]", err.message));
var engineWorker = new Worker(
  new URL("./workers/engineWorker.js", import.meta.url),
  {
    workerData: { sharedBuffer, omsPort: enginePort, ...cfg },
    transferList: [enginePort]
  }
);
engineWorker.on("message", (m) => {
  const prefix = m.type === "signal" ? "[SIGNAL]" : "[ENGINE]";
  const s = `${prefix} ${m.msg}`;
  console.log(s);
  broadcastLog(s);
});
engineWorker.on("error", (err) => console.error("[ENGINE ERROR]", err.message));
var omsWorker = new Worker(
  new URL("./workers/omsWorker.js", import.meta.url),
  {
    workerData: {
      sharedBuffer,
      omsPort,
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
      symbol: cfg.symbol,
      dryRun: cfg.dryRun,
      maxDailyLossRate: cfg.maxDailyLossRate,
      maxDrawdownUsd: cfg.maxDrawdownUsd,
      accountBalance: cfg.accountBalance,
      riskPerTrade: cfg.riskPerTrade,
      makerFee: cfg.makerFee,
      stopAtrMult: cfg.stopAtrMult
    },
    transferList: [omsPort]
  }
);
omsWorker.on("message", (m) => {
  const labels = { fill: "[FILL] ", halt: "[HALT] ", warning: "[WARN] ", order: "[ORDER]", status: "[OMS]  ", error: "[ERROR]" };
  const s = `${labels[m.type] ?? "[OMS]  "} ${m.msg}`;
  console.log(s);
  broadcastLog(s);
  if (m.type === "fill" && m.totalPnl !== void 0) {
    stats = { pnl: m.totalPnl, wins: m.wins || 0, losses: m.losses || 0, balance: m.balance || accountBalance };
    wss.clients.forEach((client) => {
      if (client.readyState === 1) client.send(JSON.stringify({ type: "stats", ...stats }));
    });
  }
  if (m.type === "halt") {
    void Promise.all([feedWorker.terminate(), engineWorker.terminate(), omsWorker.terminate()]).then(() => process.exit(0));
  }
});
omsWorker.on("error", (err) => console.error("[OMS ERROR]", err.message));
startJitterGuard(20, (reason) => {
  console.warn(`[JITTER] ${reason}`);
});
process.on("SIGINT", () => {
  console.log("\n[VANISH] Shutting down...");
  void Promise.all([feedWorker.terminate(), engineWorker.terminate(), omsWorker.terminate()]).then(() => process.exit(0));
});
console.log("[VANISH] All threads running. Ctrl+C to stop.\n");
