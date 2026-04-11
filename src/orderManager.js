/**
 * orderManager.js
 * LIMIT entry + Software SL/TP + Persistence + History
 * Προσαρμοσμένο για MEXC Futures Contract API
 */

import {
  fetchSymbolInfo,
  getUsdtBalance,
  calculatePositionSize,
  placeLimitOrder,
  closePositionMarket,
  cancelOrder,
  cancelAllOrders,
  fetchPositions,
  fetchOpenOrders,
  getOrderStatus,
  setLeverage,
  setMarginType,
} from './mexc.js';

import { readFileSync, writeFileSync, existsSync } from 'fs';

const LEVERAGE     = 10;
const STORAGE      = '/tmp/active_orders_mexc.json';
const HISTORY_FILE = '/tmp/trade_history_mexc.json';

// ─── PERSISTENCE ──────────────────────────────────────────────────────

function loadJSON(file, fallback) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}

function saveJSON(file, data) {
  try { writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

const activeOrders = new Map(
  (loadJSON(STORAGE, [])).map(o => [o.signalId, o])
);

const tradeHistory = loadJSON(HISTORY_FILE, []);

function saveActive()  { saveJSON(STORAGE,       Array.from(activeOrders.values())); }
function saveHistory() { saveJSON(HISTORY_FILE,  tradeHistory); }

// ─── HELPERS ──────────────────────────────────────────────────────────

function getRisk() {
  return parseFloat(process.env.RISK_PERCENT || '1.5');
}

function roundTick(value, tickSize) {
  const p = Math.round(-Math.log10(tickSize));
  return parseFloat(value.toFixed(Math.max(0, p)));
}

// ─── EXECUTE SIGNAL ───────────────────────────────────────────────────

export async function executeSignal(signal) {
  const { id: signalId, pair: symbol, type, side, entry, sl, tp } = signal;

  console.log(`\n📡 Εκτέλεση [${type}] ${symbol}`);
  console.log(`   Entry: ${entry} | SL: ${sl} | TP: ${tp}`);

  try {
    // 1. Symbol info (contractSize, tickSize, minVol)
    const info = await fetchSymbolInfo(symbol);
    const { contractSize, tickSize, minVol } = info;

    // 2. Balance
    const balance = await getUsdtBalance();
    if (balance < 10) throw new Error(`Ανεπαρκές balance: $${balance.toFixed(2)}`);

    // 3. Position size σε contracts βάσει risk
    const qty = calculatePositionSize(balance, getRisk(), entry, sl, contractSize, LEVERAGE);
    if (qty < minVol) throw new Error(`Qty ${qty} < minVol ${minVol}`);

    const riskAmount      = balance * getRisk() / 100;
    const potentialProfit = riskAmount * 2.5;
    const potentialLoss   = riskAmount;

    console.log(`   📊 Contracts: ${qty} | ContractSize: ${contractSize} | Risk: ${getRisk()}% = $${riskAmount.toFixed(2)}`);
    console.log(`   🎯 Target: +$${potentialProfit.toFixed(2)} | Max Loss: -$${potentialLoss.toFixed(2)}`);

    // 4. Round prices
    const entryPrice = roundTick(entry, tickSize);
    const slPrice    = roundTick(sl, tickSize);
    const tpPrice    = roundTick(tp, tickSize);

    // 5. LIMIT order
    console.log(`\n   ▶ LIMIT ${side} @ ${entryPrice}...`);
    const limitOrder = await placeLimitOrder({
      symbol,
      side,
      price:    entryPrice,
      quantity: qty,
      leverage: LEVERAGE,
    });

    // 6. Αποθήκευση
    const orderData = {
      signalId,
      symbol,
      quantity:        qty,
      contractSize,
      side,
      type,
      entryPrice,
      sl:              slPrice,
      tp:              tpPrice,
      rr:              2.5,
      riskAmount:      parseFloat(riskAmount.toFixed(2)),
      potentialProfit: parseFloat(potentialProfit.toFixed(2)),
      potentialLoss:   parseFloat(potentialLoss.toFixed(2)),
      positionSize:    parseFloat((qty * contractSize * entryPrice).toFixed(2)),
      limitOrderId:    limitOrder.orderId,
      status:          'pending_fill',
      openTime:        null,
      placedAt:        Date.now(),
      expireAt:        signal.expireAt || Date.now() + (4 * 60 * 60 * 1000),
      leverage:        LEVERAGE,
      synced:          false,
    };

    activeOrders.set(signalId, orderData);
    saveActive();

    console.log(`\n✅ LIMIT order τοποθετήθηκε! ID: ${limitOrder.orderId}`);
    console.log(`   ⏳ Αναμονή fill... (4h expiry)\n`);

    return {
      success:      true,
      signalId,
      symbol,
      limitOrderId: limitOrder.orderId,
      entryPrice,
      sl:           slPrice,
      tp:           tpPrice,
      quantity:     qty,
      leverage:     LEVERAGE,
      riskAmount:   parseFloat(riskAmount.toFixed(2)),
    };

  } catch (err) {
    console.error(`❌ ${symbol}:`, err.message);
    return { success: false, signalId, symbol, error: err.message };
  }
}

// ─── CHECK LIMIT ORDER FILLED ─────────────────────────────────────────

export async function checkOrderFilled(signalId) {
  const order = activeOrders.get(signalId);
  if (!order || order.status !== 'pending_fill') return;

  try {
    const status = await getOrderStatus(order.symbol, order.limitOrderId);

    if (status.status === 'FILLED') {
      const actualEntry = parseFloat(status.avgPrice || status.price || order.entryPrice);
      order.status     = 'open';
      order.openTime   = Date.now();
      order.entryPrice = actualEntry;
      activeOrders.set(signalId, order);
      saveActive();
      console.log(`✅ LIMIT order γέμισε! ${order.symbol} @ ${actualEntry}`);
      return 'filled';
    }

    // Έλεγχος expiry
    if (Date.now() > order.expireAt) {
      await cancelOrder(order.symbol, order.limitOrderId).catch(() => {});
      const expired = {
        ...order,
        status:      'expired',
        closeTime:   Date.now(),
        closeReason: 'expired_4h',
        result:      'expired',
      };
      tradeHistory.unshift(expired);
      if (tradeHistory.length > 500) tradeHistory.pop();
      saveHistory();
      activeOrders.delete(signalId);
      saveActive();
      console.log(`⏰ Signal ${order.symbol} έληξε (4h)`);
      return 'expired';
    }

  } catch (err) {
    console.error(`⚠️ checkOrderFilled ${order.symbol}:`, err.message);
  }
}

// ─── SOFTWARE SL/TP ───────────────────────────────────────────────────

export async function checkAndCloseSLTP(signalId, reason, closePrice) {
  const order = activeOrders.get(signalId);
  if (!order || order.status !== 'open') return;

  try {
    console.log(`\n🔔 ${reason} HIT! Κλείσιμο ${order.symbol} @ ${closePrice}`);

    await closePositionMarket(order.symbol, order.side, order.quantity);

    const isLong  = order.side === 'BUY';
    const cs      = order.contractSize || 0.001;
    const pnl     = isLong
      ? (closePrice - order.entryPrice) * order.quantity * cs
      : (order.entryPrice - closePrice) * order.quantity * cs;

    const pnlPct  = (pnl / (order.entryPrice * order.quantity * cs / LEVERAGE)) * 100;

    const closed  = {
      ...order,
      closeTime:   Date.now(),
      closePrice,
      closeReason: reason,
      result:      reason === 'TP' ? 'won' : 'lost',
      pnl:         parseFloat(pnl.toFixed(4)),
      pnlPct:      parseFloat(pnlPct.toFixed(3)),
      duration:    Date.now() - order.openTime,
    };

    tradeHistory.unshift(closed);
    if (tradeHistory.length > 500) tradeHistory.pop();
    saveHistory();

    activeOrders.delete(signalId);
    saveActive();

    console.log(`✅ ${order.symbol} κλείστηκε (${reason}) PnL: $${pnl.toFixed(2)}\n`);
  } catch (err) {
    console.error(`❌ Σφάλμα κλεισίματος ${order.symbol}:`, err.message);
  }
}

// ─── MANUAL CLOSE ─────────────────────────────────────────────────────

export async function cancelSignalOrders(signalId, currentPrice) {
  const order = activeOrders.get(signalId);
  if (!order) return { success: false, error: 'Δεν βρέθηκε' };

  try {
    if (order.status === 'pending_fill') {
      await cancelOrder(order.symbol, order.limitOrderId);
      tradeHistory.unshift({
        ...order,
        closeTime:   Date.now(),
        closeReason: 'manual_cancel',
        result:      'cancelled',
        pnl:         0,
        pnlPct:      0,
      });
    } else if (order.status === 'open') {
      try { await cancelAllOrders(order.symbol); } catch {}
      await closePositionMarket(order.symbol, order.side, order.quantity);

      const cp      = currentPrice || order.entryPrice;
      const isLong  = order.side === 'BUY';
      const cs      = order.contractSize || 0.001;
      const pnl     = isLong
        ? (cp - order.entryPrice) * order.quantity * cs
        : (order.entryPrice - cp) * order.quantity * cs;

      tradeHistory.unshift({
        ...order,
        closeTime:   Date.now(),
        closePrice:  cp,
        closeReason: 'manual_close',
        result:      'manual_close',
        pnl:         parseFloat(pnl.toFixed(4)),
        duration:    Date.now() - (order.openTime || order.placedAt),
      });
    }

    if (tradeHistory.length > 500) tradeHistory.pop();
    saveHistory();
    activeOrders.delete(signalId);
    saveActive();

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── CANCEL ALL ───────────────────────────────────────────────────────

export async function cancelAllSignalOrders() {
  const all     = Array.from(activeOrders.values());
  const results = [];

  for (const o of all) {
    try {
      if (o.status === 'pending_fill') {
        await cancelOrder(o.symbol, o.limitOrderId).catch(() => {});
      } else {
        await cancelAllOrders(o.symbol).catch(() => {});
        await closePositionMarket(o.symbol, o.side, o.quantity);
      }

      tradeHistory.unshift({
        ...o,
        closeTime:   Date.now(),
        closeReason: 'panic',
        result:      'manual_close',
        pnl:         0,
      });

      results.push({ symbol: o.symbol, done: true });
    } catch (err) {
      results.push({ symbol: o.symbol, done: false, error: err.message });
    }
    activeOrders.delete(o.signalId);
  }

  if (tradeHistory.length > 500) tradeHistory.length = 500;
  saveHistory();
  saveActive();
  return results;
}

// ─── SYNC ΑΠΟ MEXC ────────────────────────────────────────────────────

export async function syncPositionsFromBinance() {
  try {
    const positions = await fetchPositions();
    const symbols   = new Set(positions.map(p => p.symbol));

    // Αφαίρεσε κλειστές θέσεις
    for (const [id, o] of activeOrders.entries()) {
      if (o.status === 'open' && !symbols.has(o.symbol)) {
        console.log(`🔒 Θέση ${o.symbol} έκλεισε εξωτερικά`);
        tradeHistory.unshift({
          ...o,
          closeTime:   Date.now(),
          closeReason: 'external',
          result:      'unknown',
          pnl:         0,
        });
        activeOrders.delete(id);
      }
    }

    // Πρόσθεσε νέες θέσεις που δεν υπάρχουν στη μνήμη
    for (const pos of positions) {
      const exists = Array.from(activeOrders.values())
        .find(o => o.symbol === pos.symbol && o.status === 'open');
      if (!exists) {
        const amt  = parseFloat(pos.positionAmt);
        const side = amt > 0 ? 'BUY' : 'SELL';
        const id   = `sync_${pos.symbol}_${Date.now()}`;
        activeOrders.set(id, {
          signalId:     id,
          symbol:       pos.symbol,
          quantity:     Math.abs(amt),
          contractSize: 0.001,
          side,
          type:         side === 'BUY' ? 'BULLISH' : 'BEARISH',
          entryPrice:   parseFloat(pos.entryPrice),
          sl:           0,
          tp:           0,
          rr:           2.5,
          riskAmount:   0,
          limitOrderId: null,
          status:       'open',
          openTime:     Date.now(),
          placedAt:     Date.now(),
          leverage:     parseInt(pos.leverage || 10),
          synced:       true,
        });
        console.log(`🔄 Sync: ${pos.symbol} ${side} ${Math.abs(amt)}`);
      }
    }

    saveActive();
  } catch (err) {
    console.error('⚠️ Sync error:', err.message);
  }
}

// ─── GETTERS ──────────────────────────────────────────────────────────

export function getActiveOrders() {
  return Array.from(activeOrders.values());
}

export function getTradeHistory() {
  return tradeHistory;
}

export function getStats() {
  const closed   = tradeHistory.filter(t => t.result === 'won' || t.result === 'lost');
  const won      = closed.filter(t => t.result === 'won');
  const lost     = closed.filter(t => t.result === 'lost');
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate  = closed.length > 0 ? (won.length / closed.length) * 100 : 0;

  let peak = 0, maxDrawdown = 0, running = 0;
  for (const t of [...tradeHistory].reverse()) {
    running += t.pnl || 0;
    if (running > peak) peak = running;
    const dd = peak > 0 ? ((peak - running) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    totalTrades: closed.length,
    won:         won.length,
    lost:        lost.length,
    winRate:     parseFloat(winRate.toFixed(1)),
    totalPnl:    parseFloat(totalPnl.toFixed(2)),
    maxDrawdown: parseFloat(maxDrawdown.toFixed(1)),
  };
}

export async function hasOpenOrdersForSymbol(symbol) {
  for (const o of activeOrders.values()) {
    if (o.symbol === symbol && (o.status === 'open' || o.status === 'pending_fill')) {
      return true;
    }
  }
  try {
    const positions = await fetchPositions(symbol);
    return positions.some(p => p.symbol === symbol);
  } catch {
    return false;
  }
}
