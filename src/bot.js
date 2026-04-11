/**
 * bot.js — Κύριος βρόχος
 * LIMIT entry + 4h expiry + Software SL/TP + Sync
 */

import { fetchCandles, fetchPrice, ping } from './mexc.js';
import { ictCoreEngine, checkSignalTrigger, isSignalExpired, checkTradeExit } from './ictEngine.js';
import {
  executeSignal,
  hasOpenOrdersForSymbol,
  getActiveOrders,
  syncPositionsFromBinance,
  checkOrderFilled,
  checkAndCloseSLTP,
  getStats,
} from './orderManager.js';

let isRunning     = false;
let scanTimer     = null;
let priceTimer    = null;
let slTpTimer     = null;
let syncTimer     = null;
let fillTimer     = null;
let activePairs   = [];
let allSignals    = [];  // Όλα τα signals (pending, triggered, expired, rejected)
let executedKeys  = new Set();
let lastScanTime  = null;
let lastPrices    = {};

const SCAN_INTERVAL  = parseInt(process.env.SCAN_INTERVAL_MS  || '60000');
const PRICE_INTERVAL = parseInt(process.env.PRICE_INTERVAL_MS || '15000');
const SLTP_INTERVAL  = 5000;   // SL/TP check κάθε 5s
const FILL_INTERVAL  = 15000;  // Fill check κάθε 15s
const SYNC_INTERVAL  = 30000;  // Sync κάθε 30s

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('el-GR')}] ${msg}`);
}

// ─── SCAN ─────────────────────────────────────────────────────────────

async function scanPair(symbol) {
  try {
    const candles = await fetchCandles(symbol, '1h', 200);
    if (candles.length < 30) return [];
    const signals = ictCoreEngine(candles, symbol);
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

  // Κράτα τα τελευταία 500 signals
  if (allSignals.length > 500) allSignals = allSignals.slice(0, 500);

  const pending   = allSignals.filter(s => s.status === 'pending').length;
  const triggered = allSignals.filter(s => s.status === 'triggered').length;
  const expired   = allSignals.filter(s => s.status === 'expired').length;
  log(`📋 Signals — Pending: ${pending} | Triggered: ${triggered} | Expired: ${expired}`);
}

// ─── PRICE CHECK + TRIGGER ────────────────────────────────────────────

async function runPriceCheck() {
  if (!isRunning) return;

  const pending = allSignals.filter(s => s.status === 'pending');
  if (pending.length === 0) return;

  for (const signal of pending) {

    // Έλεγχος expiry
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

        // Μόνο μία θέση ανά pair
        const hasOpen = await hasOpenOrdersForSymbol(signal.pair);
        if (hasOpen) {
          log(`⏭ ${signal.pair}: Υπάρχει ήδη ανοιχτή θέση → Rejected`);
          signal.status       = 'rejected';
          signal.rejectedAt   = Date.now();
          signal.rejectReason = 'position_exists';
          continue;
        }

        const result = await executeSignal(signal);

        if (result.success) {
          signal.status       = 'triggered';
          signal.triggeredAt  = Date.now();
          signal.limitOrderId = result.limitOrderId;
          log(`✅ ${signal.pair}: LIMIT order τοποθετήθηκε @ ${result.entryPrice}`);
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

// ─── FILL CHECK ───────────────────────────────────────────────────────

async function runFillCheck() {
  if (!isRunning) return;
  const orders = getActiveOrders().filter(o => o.status === 'pending_fill');
  for (const order of orders) {
    await checkOrderFilled(order.signalId);
  }
}

// ─── SOFTWARE SL/TP ───────────────────────────────────────────────────

async function runSLTPCheck() {
  if (!isRunning) return;
  const openOrders = getActiveOrders().filter(o => o.status === 'open');
  if (openOrders.length === 0) return;

  for (const order of openOrders) {
    if (!order.sl && !order.tp) continue;
    if (order.sl === 0 && order.tp === 0) continue;

    try {
      const { price } = await fetchPrice(order.symbol);
      lastPrices[order.symbol] = price;

      const exit = checkTradeExit(order.side, price, order.sl, order.tp);
      if (exit) {
        log(`${exit === 'TP' ? '🎯' : '🛑'} ${exit} HIT! ${order.symbol} @ ${price}`);
        await checkAndCloseSLTP(order.signalId, exit, price);
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
    await syncPositionsFromBinance();
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
  log(`   Mode: ${process.env.USE_TESTNET === 'true' ? '🧪 DEMO' : '🔴 LIVE'}`);

  await runSync();
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
  [scanTimer, priceTimer, slTpTimer, fillTimer, syncTimer]
    .forEach(t => t && clearInterval(t));
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
    mode:    process.env.USE_TESTNET === 'true' ? 'testnet' : 'live',
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
      pendingFill: getActiveOrders().filter(o => o.status === 'pending_fill'),
    },
  };
}

export function updatePairs(pairs) {
  activePairs = pairs.filter(Boolean);
  log(`♻️ Pairs: ${activePairs.join(', ')}`);
}
