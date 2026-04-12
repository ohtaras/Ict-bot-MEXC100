/**
 * bot.js — Κύριος βρόχος
 * LOCAL mode: signals → local first, user sends to MEXC manually
 */

import { fetchCandles, fetchPrice, ping } from './mexc.js';
import { ictCoreEngine, checkSignalTrigger, isSignalExpired, checkTradeExit } from './ictEngine.js';
import {
  executeSignalLocal,
  hasOpenOrdersForSymbol,
  getActiveOrders,
  syncPositionsFromBinance,
  checkOrderFilled,
  checkAndCloseSLTP,
  closeLocalOrder,
  getStats,
  getAvailableSimBalance,
} from './orderManager.js';

let isRunning    = false;
let scanTimer    = null;
let priceTimer   = null;
let slTpTimer    = null;
let syncTimer    = null;
let fillTimer    = null;
let activePairs  = [];
let allSignals   = [];
let executedKeys = new Set();
let lastScanTime = null;
let lastPrices   = {};

const SCAN_INTERVAL  = parseInt(process.env.SCAN_INTERVAL_MS  || '60000');
const PRICE_INTERVAL = parseInt(process.env.PRICE_INTERVAL_MS || '15000');
const SLTP_INTERVAL  = 5000;
const FILL_INTERVAL  = 15000;
const SYNC_INTERVAL  = 30000;

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('el-GR')}] ${msg}`);
}

// ─── SCAN ─────────────────────────────────────────────────────────────

async function scanPair(symbol) {
  try {
    const candles = await fetchCandles(symbol, '1h', 200);
    if (candles.length < 30) return [];
    const signals = ictCoreEngine(candles, symbol);

    // Pre-calculate simulation sizing — χρησιμοποιεί ΔΙΑΘΕΣΙΜΟ balance (μετά locked margins)
    const availBal    = getAvailableSimBalance();
    const riskPercent = parseFloat(process.env.RISK_PERCENT || '2.5');
    const riskAmount  = parseFloat((availBal * riskPercent / 100).toFixed(2));
    for (const s of signals) {
      s.riskAmount      = riskAmount;
      s.positionSize    = parseFloat((riskAmount * 10).toFixed(2)); // 10x leverage preview
      s.potentialProfit = parseFloat((riskAmount * 2.5).toFixed(2));
      s.potentialLoss   = riskAmount;
      s.simAvailable    = parseFloat(availBal.toFixed(2));
    }

    if (signals.length > 0) log(`🔍 ${symbol}: ${signals.length} signal(s)`);
    return signals;
  } catch (err) {
    log(`⚠️ Scan ${symbol}: ${err.message}`);
    return [];
  }
}

async function runScan() {
  if (!isRunning) return;
  lastScanTime = new Date();
  log(`\n═══ ICT Scan (${activePairs.length} pairs) ═══`);

  for (const symbol of activePairs) {
    const signals = await scanPair(symbol);
    for (const sig of signals) {
      const key = `${sig.pair}-${sig.entry}-${sig.timestamp}`;
      if (!executedKeys.has(key)) {
        allSignals.unshift({ ...sig, _key: key });
        executedKeys.add(key);
      }
    }
  }

  if (allSignals.length > 500) allSignals = allSignals.slice(0, 500);

  const pending   = allSignals.filter(s => s.status === 'pending').length;
  const triggered = allSignals.filter(s => s.status === 'triggered').length;
  const expired   = allSignals.filter(s => s.status === 'expired').length;
  log(`📋 Signals — Pending: ${pending} | Triggered: ${triggered} | Expired: ${expired}`);
}

// ─── PRICE CHECK + TRIGGER ─────────────────────────────────────────────
// Όταν τιμή μπει στο FVG → δημιουργεί LOCAL order (paper trading)

async function runPriceCheck() {
  if (!isRunning) return;
  const pending = allSignals.filter(s => s.status === 'pending');
  if (pending.length === 0) return;

  for (const signal of pending) {
    if (isSignalExpired(signal)) {
      signal.status       = 'expired';
      signal.expiredAt    = Date.now();
      signal.expireReason = 'expired_4h';
      log(`⏰ Expired: ${signal.pair} [${signal.type}]`);
      continue;
    }

    try {
      const { price } = await fetchPrice(signal.pair);
      lastPrices[signal.pair] = price;

      if (checkSignalTrigger(signal, price)) {
        log(`🎯 TRIGGER! ${signal.pair} [${signal.type}] @ ${price}`);
        signal.status = 'triggering';

        const hasOpen = await hasOpenOrdersForSymbol(signal.pair);
        if (hasOpen) {
          log(`⏭ ${signal.pair}: Υπάρχει ήδη θέση → Rejected`);
          signal.status       = 'rejected';
          signal.rejectedAt   = Date.now();
          signal.rejectReason = 'position_exists';
          continue;
        }

        // Πάντα local first
        const result = await executeSignalLocal(signal);

        if (result.success) {
          signal.status      = 'triggered';
          signal.triggeredAt = Date.now();
          log(`📋 ${signal.pair}: Τοπική εντολή δημιουργήθηκε @ ${result.entryPrice}`);
        } else {
          signal.status       = 'rejected';
          signal.rejectedAt   = Date.now();
          signal.rejectReason = result.error;
          log(`❌ ${signal.pair}: ${result.error}`);
        }
      }
    } catch (err) {
      signal.status       = 'rejected';
      signal.rejectedAt   = Date.now();
      signal.rejectReason = err.message;
      log(`⚠️ ${signal.pair}: ${err.message}`);
    }
  }
}

// ─── FILL CHECK (μόνο για real MEXC orders) ───────────────────────────

async function runFillCheck() {
  if (!isRunning) return;
  const orders = getActiveOrders().filter(o => o.status === 'pending_fill');
  for (const order of orders) {
    await checkOrderFilled(order.signalId);
  }
}

// ─── SL/TP CHECK ──────────────────────────────────────────────────────
// Χειρίζεται και local και real MEXC orders

async function runSLTPCheck() {
  if (!isRunning) return;
  const openOrders = getActiveOrders().filter(o =>
    o.status === 'open' || o.status === 'open_local'
  );
  if (openOrders.length === 0) return;

  for (const order of openOrders) {
    if (!order.sl && !order.tp) continue;
    if (order.sl === 0 && order.tp === 0) continue;

    try {
      const { price } = await fetchPrice(order.symbol);
      lastPrices[order.symbol] = price;

      const exit = checkTradeExit(order.side, price, order.sl, order.tp);
      if (exit) {
        log(`${exit === 'TP' ? '🎯' : '🛑'} ${exit} HIT! ${order.symbol} @ ${price} [${order.isLocal ? 'LOCAL' : 'MEXC'}]`);

        if (order.isLocal || order.status === 'open_local') {
          // Simulation close — δεν καλεί το MEXC
          closeLocalOrder(order.signalId, exit, price);
        } else {
          // Real MEXC close
          await checkAndCloseSLTP(order.signalId, exit, price);
        }
      }
    } catch (err) {
      log(`⚠️ SL/TP ${order.symbol}: ${err.message}`);
    }
  }
}

// ─── SYNC ─────────────────────────────────────────────────────────────

async function runSync() {
  if (!isRunning) return;
  try {
    // Sync μόνο αν υπάρχουν real MEXC orders
    const hasMexcOrders = getActiveOrders().some(o => !o.isLocal);
    if (hasMexcOrders) await syncPositionsFromBinance();
  } catch (err) {
    log(`⚠️ Sync: ${err.message}`);
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────

export async function startBot(pairs) {
  if (isRunning) { log('⚠️ Bot τρέχει ήδη'); return false; }

  const ok = await ping();
  if (!ok) { log('❌ Δεν υπάρχει σύνδεση με MEXC'); return false; }

  activePairs = pairs.filter(Boolean);
  isRunning   = true;

  log(`🚀 Bot ξεκίνησε! Pairs: ${activePairs.join(', ')}`);
  log(`   Mode: LOCAL → MEXC on demand`);

  await runScan();

  scanTimer  = setInterval(runScan,       SCAN_INTERVAL);
  priceTimer = setInterval(runPriceCheck, PRICE_INTERVAL);
  slTpTimer  = setInterval(runSLTPCheck,  SLTP_INTERVAL);
  fillTimer  = setInterval(runFillCheck,  FILL_INTERVAL);
  syncTimer  = setInterval(runSync,       SYNC_INTERVAL);

  return true;
}

export function stopBot() {
  isRunning = false;
  [scanTimer, priceTimer, slTpTimer, fillTimer, syncTimer].forEach(t => t && clearInterval(t));
  scanTimer = priceTimer = slTpTimer = fillTimer = syncTimer = null;
  log('🛑 Bot σταμάτησε');
}

export function getBotStatus() {
  const stats = getStats();
  return {
    isRunning,
    activePairs,
    lastScanTime: lastScanTime?.toISOString() || null,
    lastPrices,
    mode: 'local',
    stats,
    signals: {
      all:       allSignals.slice(0, 100),
      pending:   allSignals.filter(s => s.status === 'pending').length,
      triggered: allSignals.filter(s => s.status === 'triggered').length,
      expired:   allSignals.filter(s => s.status === 'expired').length,
      rejected:  allSignals.filter(s => s.status === 'rejected').length,
    },
    orders: {
      open:        getActiveOrders().filter(o => o.status === 'open'),
      openLocal:   getActiveOrders().filter(o => o.status === 'open_local'),
      pendingFill: getActiveOrders().filter(o => o.status === 'pending_fill'),
    },
  };
}

export function updatePairs(pairs) {
  activePairs = pairs.filter(Boolean);
  log(`♻️ Pairs: ${activePairs.join(', ')}`);
}
