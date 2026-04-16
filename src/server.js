/**
 * server.js — Express REST API + Static Dashboard
 * MEXC Futures · Local Mode + Send to MEXC + Dual Analytics
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
  fetchAllSymbols,
  fetchTopSymbolsByVolume,
  ping,
} from './mexc.js';
import {
  cancelSignalOrders,
  cancelAllSignalOrders,
  sendOrderToMEXC,
  getActiveOrders,
  getTradeHistory,
  getLocalHistory,
  getStats,
  getLocalStats,
  getAvailableSimBalance,
  resetSimulation,
} from './orderManager.js';

const __dirname       = dirname(fileURLToPath(import.meta.url));
const app             = express();
const PORT            = process.env.PORT || 8080;
const SETTINGS_FILE   = '/tmp/bot_settings_mexc.json';
const DISABLED_FILE   = '/tmp/disabled_pairs_mexc.json';

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// ─── SETTINGS ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  riskPercent:    parseFloat(process.env.RISK_PERCENT || '1'),
  rrRatio:        parseFloat(process.env.RR_RATIO     || '1'),
  initialBalance: parseFloat(process.env.SIM_BALANCE  || '100'),
  leverage:       10,
  scanInterval:   60,
  priceInterval:  15,
  mexcApiKey:     '',
  mexcSecretKey:  '',
};

function loadSettings() {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const s = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) };
      // Φόρτωσε keys στο env αν υπάρχουν
      if (s.mexcApiKey)    process.env.MEXC_API_KEY    = s.mexcApiKey;
      if (s.mexcSecretKey) process.env.MEXC_SECRET_KEY = s.mexcSecretKey;
      if (s.initialBalance) process.env.SIM_BALANCE    = s.initialBalance.toString();
      if (s.riskPercent)    process.env.RISK_PERCENT   = s.riskPercent.toString();
      if (s.rrRatio)        process.env.RR_RATIO       = s.rrRatio.toString();
      return s;
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); } catch {}
}

let botSettings = loadSettings();

// ─── DISABLED PAIRS ───────────────────────────────────────────────────

function loadDisabledPairs() {
  try {
    if (existsSync(DISABLED_FILE)) return JSON.parse(readFileSync(DISABLED_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveDisabledPairs(list) {
  try { writeFileSync(DISABLED_FILE, JSON.stringify(list, null, 2)); } catch {}
}

let disabledPairs = loadDisabledPairs();

// ─── ALL PAIRS CACHE ──────────────────────────────────────────────────

let allMexcPairs    = [];
let pairsCachedAt   = 0;
const PAIRS_CACHE_MS = 10 * 60 * 1000; // 10 λεπτά
const TOP_PAIRS_LIMIT = 20;

async function getAllPairs() {
  if (allMexcPairs.length && Date.now() - pairsCachedAt < PAIRS_CACHE_MS) return allMexcPairs;
  const symbols = await fetchTopSymbolsByVolume(TOP_PAIRS_LIMIT);
  if (symbols.length) { allMexcPairs = symbols; pairsCachedAt = Date.now(); }
  return allMexcPairs;
}

function getActivePairs() {
  const disabled = new Set(disabledPairs);
  return allMexcPairs.filter(s => !disabled.has(s));
}

// ─── HELPERS ──────────────────────────────────────────────────────────

function hasKeys() {
  return !!(process.env.MEXC_API_KEY && process.env.MEXC_API_KEY !== 'your_api_key_here'
         && process.env.MEXC_SECRET_KEY && process.env.MEXC_SECRET_KEY !== 'your_secret_key_here');
}

function requireKeys(res) {
  if (!hasKeys()) {
    res.status(400).json({ error: 'Δεν έχεις ορίσει MEXC API Keys (Ρυθμίσεις → API Keys)' });
    return false;
  }
  return true;
}

function maskKey(key) {
  if (!key || key.length < 8) return key ? '****' : '';
  return key.slice(0, 4) + '****' + key.slice(-4);
}

// ─── HEALTH ───────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const ok = await ping();
  res.json({
    status:    'ok',
    mexc:      ok ? 'connected' : 'unreachable',
    hasKeys:   hasKeys(),
    mode:      'local',
    timestamp: new Date().toISOString(),
  });
});

// ─── STATUS ───────────────────────────────────────────────────────────
app.get('/status', (req, res) => {
  res.json({ ...getBotStatus(), settings: { ...botSettings, mexcApiKey: maskKey(botSettings.mexcApiKey), mexcSecretKey: maskKey(botSettings.mexcSecretKey) }, hasKeys: hasKeys() });
});

// ─── SETTINGS GET ─────────────────────────────────────────────────────
app.get('/settings', (req, res) => {
  res.json({
    ...botSettings,
    mexcApiKey:    maskKey(botSettings.mexcApiKey),
    mexcSecretKey: maskKey(botSettings.mexcSecretKey),
    hasKeys:       hasKeys(),
  });
});

// ─── SETTINGS POST ────────────────────────────────────────────────────
app.post('/settings', (req, res) => {
  const { riskPercent, rrRatio, initialBalance, leverage, scanInterval, priceInterval, mexcApiKey, mexcSecretKey } = req.body;

  if (riskPercent    !== undefined) botSettings.riskPercent    = parseFloat(riskPercent);
  if (rrRatio        !== undefined) botSettings.rrRatio        = parseFloat(rrRatio);
  if (initialBalance !== undefined) botSettings.initialBalance = parseFloat(initialBalance);
  if (leverage       !== undefined) botSettings.leverage       = parseInt(leverage);
  if (scanInterval   !== undefined) botSettings.scanInterval   = parseInt(scanInterval);
  if (priceInterval  !== undefined) botSettings.priceInterval  = parseInt(priceInterval);

  // API Keys — αποθηκεύονται κρυπτωμένα
  if (mexcApiKey    && mexcApiKey    !== maskKey(botSettings.mexcApiKey))    { botSettings.mexcApiKey    = mexcApiKey;    process.env.MEXC_API_KEY    = mexcApiKey;    }
  if (mexcSecretKey && mexcSecretKey !== maskKey(botSettings.mexcSecretKey)) { botSettings.mexcSecretKey = mexcSecretKey; process.env.MEXC_SECRET_KEY = mexcSecretKey; }

  process.env.RISK_PERCENT = botSettings.riskPercent.toString();
  process.env.RR_RATIO     = botSettings.rrRatio.toString();
  process.env.SIM_BALANCE  = botSettings.initialBalance.toString();

  saveSettings(botSettings);
  console.log(`⚙️ Settings updated | Risk: ${botSettings.riskPercent}% | R:R 1:${botSettings.rrRatio} | SimBalance: $${botSettings.initialBalance}`);

  res.json({
    success:  true,
    settings: { ...botSettings, mexcApiKey: maskKey(botSettings.mexcApiKey), mexcSecretKey: maskKey(botSettings.mexcSecretKey) },
    hasKeys:  hasKeys(),
  });
});

// ─── START ────────────────────────────────────────────────────────────
// Αν δεν δοθούν pairs → φορτώνει ΟΛΕΣ τις MEXC futures παρ. disabled
app.post('/start', async (req, res) => {
  const { pairs } = req.body;
  let activePairList;

  if (!pairs || !Array.isArray(pairs) || pairs.length === 0) {
    // Αυτόματη φόρτωση όλων των pairs
    await getAllPairs();
    activePairList = getActivePairs();
    if (activePairList.length === 0) return res.status(500).json({ error: 'Δεν βρέθηκαν pairs από MEXC' });
  } else {
    activePairList = pairs;
  }

  const started = await startBot(activePairList, botSettings);
  res.json(started
    ? { success: true,  message: `Bot ξεκίνησε: ${activePairList.length} pairs (${disabledPairs.length} disabled)` }
    : { success: false, error:   'Τρέχει ήδη ή δεν υπάρχει σύνδεση' }
  );
});

// ─── STOP ─────────────────────────────────────────────────────────────
app.post('/stop', (req, res) => {
  stopBot();
  res.json({ success: true });
});

// ─── PAIRS — όλα (με status enabled/disabled) ─────────────────────────
app.get('/pairs/all', async (req, res) => {
  try {
    const all      = await getAllPairs();
    const disabled = new Set(disabledPairs);
    res.json({
      total:    all.length,
      active:   all.length - disabled.size,
      disabled: disabledPairs.length,
      pairs:    all.map(s => ({ symbol: s, enabled: !disabled.has(s) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DISABLE pair ─────────────────────────────────────────────────────
app.post('/pairs/disable/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!disabledPairs.includes(symbol)) {
    disabledPairs.push(symbol);
    saveDisabledPairs(disabledPairs);
    // Αφαίρεση από ενεργά pairs του bot αμέσως
    updatePairs(getActivePairs());
    console.log(`🔕 Disabled: ${symbol}`);
  }
  res.json({ success: true, symbol, disabled: true, totalDisabled: disabledPairs.length });
});

// ─── ENABLE pair ──────────────────────────────────────────────────────
app.post('/pairs/enable/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  disabledPairs = disabledPairs.filter(s => s !== symbol);
  saveDisabledPairs(disabledPairs);
  // Επαναφορά στα ενεργά pairs
  updatePairs(getActivePairs());
  console.log(`🔔 Enabled: ${symbol}`);
  res.json({ success: true, symbol, disabled: false, totalDisabled: disabledPairs.length });
});

// ─── ENABLE ALL pairs ─────────────────────────────────────────────────
app.post('/pairs/enable-all', (req, res) => {
  disabledPairs = [];
  saveDisabledPairs(disabledPairs);
  updatePairs(getActivePairs());
  res.json({ success: true, message: 'Όλα τα pairs ενεργοποιήθηκαν' });
});

// ─── PAIRS (legacy endpoint) ──────────────────────────────────────────
app.post('/pairs', (req, res) => {
  const { pairs } = req.body;
  if (!pairs || !Array.isArray(pairs)) return res.status(400).json({ error: 'Δώσε pairs: [...]' });
  updatePairs(pairs);
  res.json({ success: true, pairs });
});

// ─── ACCOUNT (χρειάζεται API keys) ───────────────────────────────────
app.get('/account', async (req, res) => {
  if (!hasKeys()) {
    return res.json({ totalBalance: 0, usdtBalance: 0, availableBalance: 0, unrealizedPnl: 0, canTrade: false, mode: 'local', noKeys: true });
  }
  try {
    const account = await fetchAccountInfo();
    const assets  = account.assets || [];
    const usdt    = assets.find(a => a.asset === 'USDT');
    const usdc    = assets.find(a => a.asset === 'USDC');
    res.json({
      totalBalance:     parseFloat(usdt?.walletBalance || 0) + parseFloat(usdc?.walletBalance || 0),
      usdtBalance:      parseFloat(usdt?.walletBalance || 0),
      usdcBalance:      parseFloat(usdc?.walletBalance || 0),
      availableBalance: parseFloat(usdt?.availableBalance || 0),
      unrealizedPnl:    parseFloat(account.totalUnrealizedProfit || 0),
      canTrade:         true,
      mode:             'live',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PNL ──────────────────────────────────────────────────────────────
app.get('/pnl', async (req, res) => {
  try {
    const orders = getActiveOrders();

    const { lastPrices } = getBotStatus();

    // Local orders (simulation) — live PnL estimated from lastPrices
    const localPositions = orders
      .filter(o => o.status === 'open_local')
      .map(o => {
        const curPrice = lastPrices[o.symbol] || null;
        let pnlVal = null, pnlPct = null;
        if (curPrice && o.sl && o.potentialLoss) {
          // Scale PnL proportionally between SL and TP
          const slDist = Math.abs(o.entryPrice - o.sl);
          if (slDist > 0) {
            const move = o.side === 'BUY'
              ? curPrice - o.entryPrice
              : o.entryPrice - curPrice;
            pnlVal = parseFloat(((move / slDist) * o.potentialLoss).toFixed(2));
            const tpDist = Math.abs(o.tp - o.entryPrice);
            pnlPct = tpDist > 0 ? parseFloat(((move / tpDist) * 250).toFixed(1)) : 0;
          }
        }
        return {
          signalId:        o.signalId,
          symbol:          o.symbol,
          side:            o.side,
          entryPrice:      o.entryPrice,
          currentPrice:    curPrice,
          quantity:        o.quantity,
          pnl:             pnlVal,
          pnlPct:          pnlPct,
          sl:              o.sl,
          tp:              o.tp,
          rr:              2.5,
          openTime:        o.openTime,
          leverage:        o.leverage,
          status:          'open_local',
          isLocal:         true,
          sentToMEXC:      false,
          riskAmount:      o.riskAmount,
          potentialProfit: o.potentialProfit,
          potentialLoss:   o.potentialLoss,
          positionSize:    o.positionSize,
        };
      });

    // Pending fill (real MEXC)
    const pendingFills = orders
      .filter(o => o.status === 'pending_fill')
      .map(o => ({
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
        isLocal:         false,
        sentToMEXC:      true,
        riskAmount:      o.riskAmount,
        potentialProfit: o.potentialProfit,
        potentialLoss:   o.potentialLoss,
        positionSize:    o.positionSize,
        expireAt:        o.expireAt,
      }));

    // Real MEXC open positions (αν υπάρχουν keys)
    let mexcPositions = [];
    if (hasKeys()) {
      try {
        const positions = await fetchPositions();
        mexcPositions = positions.map(pos => {
          const amt        = parseFloat(pos.positionAmt);
          const side       = amt > 0 ? 'BUY' : 'SELL';
          const entryPrice = parseFloat(pos.entryPrice);
          const markPrice  = parseFloat(pos.markPrice);
          const unrealPnl  = parseFloat(pos.unRealizedProfit);
          const quantity   = Math.abs(amt);
          const leverage   = parseInt(pos.leverage || botSettings.leverage);
          const tracked    = orders.find(o => o.symbol === pos.symbol && o.status === 'open');
          const sl         = tracked?.sl || 0;
          const tp         = tracked?.tp || 0;
          const cs         = tracked?.contractSize || 0.001;
          const pnlPct     = entryPrice > 0 ? (unrealPnl / (entryPrice * quantity * cs / leverage)) * 100 : 0;
          const range      = Math.abs(tp - sl);
          const prog       = (range > 0 && markPrice > 0) ? Math.max(0, Math.min(100, Math.abs(markPrice - sl) / range * 100)) : 0;
          return {
            signalId:        tracked?.signalId || `live_${pos.symbol}`,
            symbol:          pos.symbol,
            side, entryPrice,
            currentPrice:    markPrice,
            quantity,
            pnl:             parseFloat(unrealPnl.toFixed(4)),
            pnlPct:          parseFloat(pnlPct.toFixed(3)),
            sl, tp, rr: 2.5, openTime: tracked?.openTime || Date.now(), leverage, progress: prog,
            status:          'open',
            isLocal:         false,
            sentToMEXC:      true,
            riskAmount:      tracked?.riskAmount      || 0,
            potentialProfit: tracked?.potentialProfit || 0,
            potentialLoss:   tracked?.potentialLoss   || 0,
            positionSize:    tracked?.positionSize    || 0,
            duration:        Date.now() - (tracked?.openTime || Date.now()),
          };
        });
      } catch {}
    }

    res.json([...localPositions, ...mexcPositions, ...pendingFills]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SEND TO MEXC ─────────────────────────────────────────────────────
app.post('/send-to-mexc/:signalId', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const result = await sendOrderToMEXC(req.params.signalId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYTICS LOCAL ──────────────────────────────────────────────────
app.get('/analytics/local', (req, res) => {
  const history  = getLocalHistory();
  const stats    = getLocalStats();
  const initialBalance = botSettings.initialBalance || 10000;

  const trades = history
    .filter(t => t.result === 'won' || t.result === 'lost' || t.result === 'manual_close')
    .map(t => ({
      symbol:     t.symbol,
      pnl:        t.pnl || 0,
      time:       t.closeTime || t.placedAt,
      tradeId:    t.signalId,
      side:       t.side,
      entryPrice: t.entryPrice,
      closePrice: t.closePrice,
      result:     t.result,
      duration:   t.duration,
    }));

  const sortedTrades = [...trades].sort((a, b) => a.time - b.time);
  let running = initialBalance, peak = initialBalance, maxDrawdown = 0;
  const equity = [{ time: Date.now() - 30 * 24 * 60 * 60 * 1000, balance: initialBalance }];

  for (const t of sortedTrades) {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    equity.push({ time: t.time, balance: parseFloat(running.toFixed(2)), pnl: t.pnl });
  }

  const dayGroups = {};
  for (const t of sortedTrades) {
    const day = new Date(t.time).toLocaleDateString('el-GR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    if (!dayGroups[day]) dayGroups[day] = { trades: [], pnl: 0, won: 0, lost: 0 };
    dayGroups[day].trades.push(t);
    dayGroups[day].pnl += t.pnl;
    if (t.pnl > 0) dayGroups[day].won++; else dayGroups[day].lost++;
  }

  const grossProfit = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));

  res.json({
    source:           'local',
    currentBalance:   parseFloat(running.toFixed(2)),
    unrealizedPnl:    0,
    totalPnl:         parseFloat((running - initialBalance).toFixed(2)),
    totalFunding:     0,
    totalCommissions: 0,
    netPnl:           parseFloat((running - initialBalance).toFixed(2)),
    totalTrades:      trades.length,
    won:              stats.won,
    lost:             stats.lost,
    winRate:          stats.winRate,
    profitFactor:     grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : 0,
    maxDrawdown:      parseFloat(maxDrawdown.toFixed(1)),
    equity,
    dayGroups,
    trades:           sortedTrades.reverse(),
  });
});

// ─── ANALYTICS MEXC ───────────────────────────────────────────────────
app.get('/analytics/mexc', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const data = await fetchBinanceAnalytics(botSettings.initialBalance);
    res.json({ ...data, source: 'mexc' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SYMBOLS (all MEXC futures pairs) ────────────────────────────────
let cachedSymbols = [];
let symbolsCachedAt = 0;
app.get('/symbols', async (req, res) => {
  try {
    // Cache for 10 minutes
    if (cachedSymbols.length && Date.now() - symbolsCachedAt < 600_000) {
      return res.json({ symbols: cachedSymbols, count: cachedSymbols.length, cached: true });
    }
    const symbols = await fetchAllSymbols();
    if (symbols.length) { cachedSymbols = symbols; symbolsCachedAt = Date.now(); }
    res.json({ symbols: symbols.length ? symbols : cachedSymbols, count: symbols.length || cachedSymbols.length });
  } catch (err) {
    res.json({ symbols: cachedSymbols, count: cachedSymbols.length, error: err.message });
  }
});

// ─── HISTORY ──────────────────────────────────────────────────────────
app.get('/history',       (req, res) => res.json(getTradeHistory()));
app.get('/history/local', (req, res) => res.json(getLocalHistory()));

// ─── STATS ────────────────────────────────────────────────────────────
app.get('/stats', (req, res) => {
  res.json({
    mexc:              getStats(),
    local:             getLocalStats(),
    settings:          botSettings,
    simAvailableBalance: getAvailableSimBalance(),
    simInitialBalance:   botSettings.initialBalance,
  });
});

// ─── CANCEL SINGLE ────────────────────────────────────────────────────
app.post('/cancel/:signalId', async (req, res) => {
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
  try {
    const results = await cancelAllSignalOrders();
    res.json({ cancelled: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RESET SIMULATION ─────────────────────────────────────────────────
// Καθαρίζει όλες τις paper θέσεις & history — φρέσκο ξεκίνημα
app.post('/reset-sim', (req, res) => {
  try {
    const result = resetSimulation();
    console.log(`🔄 Simulation reset! Νέο balance: $${botSettings.initialBalance}`);
    res.json({
      ...result,
      initialBalance:   botSettings.initialBalance,
      availableBalance: botSettings.initialBalance,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POSITIONS ────────────────────────────────────────────────────────
app.get('/positions', async (req, res) => {
  if (!requireKeys(res)) return;
  try { res.json(await fetchPositions()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SERVER ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║     ICT Trading Bot - MEXC Futures     ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`\n🌐 Server: http://localhost:${PORT}`);
  console.log(`📋 Mode: LOCAL → MEXC on demand`);
  console.log(`🔑 API Keys: ${hasKeys() ? '✅ Configured' : '⚠️  Not set (Local only)'}`);
  console.log(`⚙️  Risk: ${botSettings.riskPercent}% | SimBalance: $${botSettings.initialBalance}\n`);

  // ── Auto-start: φορτώνει ΟΛΕΣ τις MEXC pairs και ξεκινά αμέσως ──────
  console.log('⏳ Φόρτωση όλων των MEXC pairs...');
  (async () => {
    try {
      const pairs  = await getAllPairs();
      const active = getActivePairs();
      console.log(`📊 ${pairs.length} pairs φορτώθηκαν | ${disabledPairs.length} disabled | ${active.length} ενεργά`);
      const ok = await startBot(active, botSettings);
      if (ok) console.log(`🚀 Bot ξεκίνησε αυτόματα με ${active.length} pairs!\n`);
    } catch (err) {
      console.error('⚠️ Auto-start error:', err.message);
    }
  })();
});
