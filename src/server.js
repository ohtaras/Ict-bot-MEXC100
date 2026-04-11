/**
 * server.js — Express REST API + Static Dashboard
 * MEXC Futures version
 */

import 'dotenv/config';
import express from 'express';
import cors    from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { startBot, stopBot, getBotStatus, updatePairs } from './bot.js';
import {
  fetchAccountInfo,
  fetchPositions,
  fetchBinanceAnalytics,
  ping,
} from './mexc.js';
import {
  cancelSignalOrders,
  cancelAllSignalOrders,
  getActiveOrders,
  getTradeHistory,
  getStats,
} from './orderManager.js';

const __dirname     = dirname(fileURLToPath(import.meta.url));
const app           = express();
const PORT          = process.env.PORT || 8080;
const SETTINGS_FILE = '/tmp/bot_settings_mexc.json';

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ─── SETTINGS ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  riskPercent:    parseFloat(process.env.RISK_PERCENT || '2'),
  initialBalance: 10000,
  leverage:       10,
  scanInterval:   60,
  priceInterval:  15,
};

function loadSettings() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let botSettings = loadSettings();

// ─── HELPERS ──────────────────────────────────────────────────────────

function requireKeys(res) {
  if (!process.env.MEXC_API_KEY || process.env.MEXC_API_KEY === 'your_api_key_here') {
    res.status(400).json({ error: 'Δεν έχεις ορίσει MEXC_API_KEY' });
    return false;
  }
  if (!process.env.MEXC_SECRET_KEY || process.env.MEXC_SECRET_KEY === 'your_secret_key_here') {
    res.status(400).json({ error: 'Δεν έχεις ορίσει MEXC_SECRET_KEY' });
    return false;
  }
  return true;
}

// ─── HEALTH ───────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const ok = await ping();
  res.json({
    status:    'ok',
    mexc:      ok ? 'connected' : 'unreachable',
    mode:      process.env.USE_TESTNET === 'true' ? 'demo' : 'live',
    timestamp: new Date().toISOString(),
  });
});

// ─── STATUS ───────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ ...getBotStatus(), settings: botSettings });
});

// ─── SETTINGS ─────────────────────────────────────────────────────────
app.get('/settings', (req, res) => {
  res.json(botSettings);
});

app.post('/settings', (req, res) => {
  const { riskPercent, initialBalance, leverage, scanInterval, priceInterval } = req.body;
  if (riskPercent    !== undefined) botSettings.riskPercent    = parseFloat(riskPercent);
  if (initialBalance !== undefined) botSettings.initialBalance = parseFloat(initialBalance);
  if (leverage       !== undefined) botSettings.leverage       = parseInt(leverage);
  if (scanInterval   !== undefined) botSettings.scanInterval   = parseInt(scanInterval);
  if (priceInterval  !== undefined) botSettings.priceInterval  = parseInt(priceInterval);
  saveSettings(botSettings);
  process.env.RISK_PERCENT = botSettings.riskPercent.toString();
  console.log(`⚙️ Settings:`, botSettings);
  res.json({ success: true, settings: botSettings });
});

// ─── START ────────────────────────────────────────────────────────────
app.post('/start', async (req, res) => {
  if (!requireKeys(res)) return;
  const { pairs } = req.body;
  if (!pairs || !Array.isArray(pairs) || pairs.length === 0) {
    return res.status(400).json({ error: 'Δώσε pairs: ["BTCUSDT", ...]' });
  }
  const started = await startBot(pairs, botSettings);
  res.json(started
    ? { success: true,  message: `Bot ξεκίνησε: ${pairs.join(', ')}` }
    : { success: false, error:   'Τρέχει ήδη ή δεν υπάρχει σύνδεση' }
  );
});

// ─── STOP ─────────────────────────────────────────────────────────────
app.post('/stop', (req, res) => {
  stopBot();
  res.json({ success: true });
});

// ─── PAIRS ────────────────────────────────────────────────────────────
app.post('/pairs', (req, res) => {
  const { pairs } = req.body;
  if (!pairs || !Array.isArray(pairs)) {
    return res.status(400).json({ error: 'Δώσε pairs: [...]' });
  }
  updatePairs(pairs);
  res.json({ success: true, pairs });
});

// ─── ACCOUNT ──────────────────────────────────────────────────────────
app.get('/account', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const account = await fetchAccountInfo();
    const assets  = account.assets || [];
    const usdt    = assets.find(a => a.asset === 'USDT');
    const usdc    = assets.find(a => a.asset === 'USDC');
    const usdtWallet    = parseFloat(usdt?.walletBalance    || usdt?.cashBalance    || 0);
    const usdcWallet    = parseFloat(usdc?.walletBalance    || usdc?.cashBalance    || 0);
    const available     = parseFloat(usdt?.availableBalance || 0);
    const totalBalance  = usdtWallet + usdcWallet;
    const unrealizedPnl = parseFloat(account.totalUnrealizedProfit || 0);
    res.json({
      totalBalance,
      usdtBalance:      usdtWallet,
      usdcBalance:      usdcWallet,
      availableBalance: available,
      unrealizedPnl,
      canTrade: true,
      mode:     process.env.USE_TESTNET === 'true' ? 'demo' : 'live',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PNL (live από MEXC) ──────────────────────────────────────────────
app.get('/pnl', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const positions = await fetchPositions();
    const orders    = getActiveOrders();

    const pnlList = positions.map(pos => {
      const symbol     = pos.symbol;
      const amt        = parseFloat(pos.positionAmt);
      const side       = amt > 0 ? 'BUY' : 'SELL';
      const entryPrice = parseFloat(pos.entryPrice);
      const markPrice  = parseFloat(pos.markPrice);
      const unrealPnl  = parseFloat(pos.unRealizedProfit);
      const quantity   = Math.abs(amt);
      const leverage   = parseInt(pos.leverage || botSettings.leverage);
      const tracked    = orders.find(o => o.symbol === symbol);
      const sl         = tracked?.sl       || 0;
      const tp         = tracked?.tp       || 0;
      const signalId   = tracked?.signalId || `live_${symbol}`;
      const openTime   = tracked?.openTime || Date.now();
      const cs         = tracked?.contractSize || 0.001;
      const pnlPct     = entryPrice > 0
        ? (unrealPnl / (entryPrice * quantity * cs / leverage)) * 100
        : 0;
      const range = Math.abs(tp - sl);
      const prog  = (range > 0 && markPrice > 0)
        ? Math.max(0, Math.min(100, Math.abs(markPrice - sl) / range * 100))
        : 0;

      return {
        signalId, symbol, side, entryPrice,
        currentPrice:    markPrice,
        quantity,
        pnl:             parseFloat(unrealPnl.toFixed(4)),
        pnlPct:          parseFloat(pnlPct.toFixed(3)),
        sl, tp, rr: 2.5, openTime, leverage, progress: prog,
        riskAmount:      tracked?.riskAmount      || 0,
        potentialProfit: tracked?.potentialProfit || 0,
        potentialLoss:   tracked?.potentialLoss   || 0,
        positionSize:    tracked?.positionSize    || 0,
        duration:        Date.now() - openTime,
      };
    });

    const pendingFills = orders.filter(o => o.status === 'pending_fill').map(o => ({
      signalId:        o.signalId,
      symbol:          o.symbol,
      side:            o.side,
      entryPrice:      o.entryPrice,
      currentPrice:    null,
      quantity:        o.quantity,
      pnl:             null,
      pnlPct:          null,
      sl:              o.sl,
      tp:              o.tp,
      rr:              2.5,
      openTime:        o.placedAt,
      leverage:        o.leverage,
      status:          'pending_fill',
      riskAmount:      o.riskAmount,
      potentialProfit: o.potentialProfit,
      potentialLoss:   o.potentialLoss,
      positionSize:    o.positionSize,
      expireAt:        o.expireAt,
    }));

    res.json([...pnlList, ...pendingFills]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYTICS (100% από MEXC) ────────────────────────────────────────
app.get('/analytics', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const data = await fetchBinanceAnalytics(botSettings.initialBalance);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HISTORY ──────────────────────────────────────────────────────────
app.get('/history', (req, res) => {
  res.json(getTradeHistory());
});

// ─── STATS ────────────────────────────────────────────────────────────
app.get('/stats', (req, res) => {
  res.json({ ...getStats(), settings: botSettings });
});

// ─── CANCEL SINGLE ────────────────────────────────────────────────────
app.post('/cancel/:signalId', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const { currentPrice } = req.body;
    const result = await cancelSignalOrders(req.params.signalId, currentPrice);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CANCEL ALL ───────────────────────────────────────────────────────
app.post('/cancel-all', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const results = await cancelAllSignalOrders();
    res.json({ cancelled: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POSITIONS ────────────────────────────────────────────────────────
app.get('/positions', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    res.json(await fetchPositions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SERVER ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║     ICT Trading Bot - MEXC Futures     ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n🌐 Server: http://localhost:${PORT}`);
  console.log(`📡 Mode: ${process.env.USE_TESTNET === 'true' ? '🧪 DEMO' : '🔴 LIVE'}`);
  console.log(`⚙️  Risk: ${botSettings.riskPercent}% | Leverage: ${botSettings.leverage}x\n`);
});
