/**
 * orderManager.js
 * LOCAL mode (paper trading) + optional send to MEXC
 * Dual history: local simulation + real MEXC trades
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

const LEVERAGE          = 10;
const MAKER_FEE         = 0.0002;   // 0.02% — MEXC Futures limit order fee
const TAKER_FEE         = 0.0006;   // 0.06% — MEXC Futures market order fee
const STORAGE           = '/tmp/active_orders_mexc.json';
const HISTORY_FILE      = '/tmp/trade_history_mexc.json';
const LOCAL_HISTORY_FILE = '/tmp/local_history_mexc.json';
const SIM_RESET_FILE    = '/tmp/sim_reset_mexc.json';

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
const tradeHistory  = loadJSON(HISTORY_FILE,       []);  // real MEXC closes
const localHistory  = loadJSON(LOCAL_HISTORY_FILE, []);  // simulation closes

function saveActive()       { saveJSON(STORAGE,            Array.from(activeOrders.values())); }
function saveHistory()      { saveJSON(HISTORY_FILE,       tradeHistory); }
function saveLocalHistory() { saveJSON(LOCAL_HISTORY_FILE, localHistory); }

// ─── HELPERS ──────────────────────────────────────────────────────────

function getRisk() {
  return parseFloat(process.env.RISK_PERCENT || '2.5');
}

function getSimBalance() {
  return parseFloat(process.env.SIM_BALANCE || '100');
}

/**
 * Υπολογισμός δεσμευμένου margin για ένα ανοιχτό paper order
 * MEXC Isolated Margin = (contracts × contractSize × entryPrice) / leverage
 */
function calcLockedMargin(order) {
  return (order.quantity * (order.contractSize || 0.001) * order.entryPrice) / (order.leverage || LEVERAGE);
}

/**
 * Διαθέσιμο simulation balance = αρχικό + realized PnL - δεσμευμένα margins
 * Αντικατοπτρίζει ακριβώς το "Available Balance" της MEXC σε isolated mode
 */
export function getAvailableSimBalance() {
  const initial      = getSimBalance();
  const realizedPnl  = localHistory.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const currentBal   = initial + realizedPnl;
  let   lockedMargin = 0;
  for (const order of activeOrders.values()) {
    if (order.isLocal && order.status === 'open_local') {
      lockedMargin += calcLockedMargin(order);
    }
  }
  return Math.max(0, parseFloat((currentBal - lockedMargin).toFixed(4)));
}

function roundTick(value, tickSize) {
  const p = Math.round(-Math.log10(tickSize));
  return parseFloat(value.toFixed(Math.max(0, p)));
}

// ─── LOCAL EXECUTION (Paper Trading) ─────────────────────────────────
// Προσομοιώνει ακριβώς τη συμπεριφορά MEXC Futures Isolated Margin

export async function executeSignalLocal(signal) {
  const { id: signalId, pair: symbol, type, side, entry, sl, tp } = signal;

  const riskPercent      = getRisk();
  const availableBalance = getAvailableSimBalance();
  const contractSize     = 0.001;

  // ── Υπολογισμός qty βάσει ΔΙΑΘΕΣΙΜΟΥ κεφαλαίου ─────────────────────
  let qty = 1;
  try {
    qty = calculatePositionSize(availableBalance, riskPercent, entry, sl, contractSize, LEVERAGE);
  } catch {}

  // ── MEXC Isolated Margin = notional / leverage ───────────────────────
  const notional       = qty * contractSize * entry;
  const marginRequired = notional / LEVERAGE;

  // ── MEXC Trading Fee (maker 0.02% × notional) ────────────────────────
  const openFee        = notional * MAKER_FEE;   // fee για άνοιγμα
  const closeFeeEst    = notional * MAKER_FEE;   // εκτιμώμενο fee κλεισίματος
  const totalCost      = marginRequired + openFee;

  // ── ΑΥΣΤΗΡΟΣ ΕΛΕΓΧΟΣ — ακριβώς όπως η MEXC ─────────────────────────
  // Η MEXC απαιτεί: available >= initialMargin + openFee
  if (availableBalance < totalCost) {
    const msg = `Ανεπαρκές margin: χρειάζεται $${totalCost.toFixed(4)} (margin $${marginRequired.toFixed(4)} + fee $${openFee.toFixed(4)}), διαθέσιμο $${availableBalance.toFixed(4)}`;
    console.log(`❌ ${symbol}: ${msg}`);
    return { success: false, error: msg };
  }

  // ── Risk & PnL (μετά από fees) ────────────────────────────────────────
  const riskAmount      = availableBalance * riskPercent / 100;
  // Πραγματικό max loss = riskAmount + openFee + closeFee (αν SL)
  const potentialLoss   = parseFloat((riskAmount + openFee + closeFeeEst).toFixed(4));
  // Πραγματικό max profit = riskAmount*2.5 - openFee - closeFee (αν TP)
  const potentialProfit = parseFloat((riskAmount * 2.5 - openFee - closeFeeEst).toFixed(4));

  const positionSize = parseFloat(notional.toFixed(4));

  const orderData = {
    signalId,
    symbol,
    quantity:          qty,
    contractSize,
    side,
    type,
    entryPrice:        entry,
    sl,
    tp,
    rr:                2.5,
    riskAmount:        parseFloat(riskAmount.toFixed(4)),
    potentialProfit,
    potentialLoss,
    positionSize,
    marginRequired:    parseFloat(marginRequired.toFixed(4)),
    openFee:           parseFloat(openFee.toFixed(4)),
    availableAtOpen:   parseFloat(availableBalance.toFixed(4)),
    limitOrderId:      null,
    status:            'open_local',
    isLocal:           true,
    sentToMEXC:        false,
    openTime:          Date.now(),
    placedAt:          Date.now(),
    expireAt:          signal.expireAt || Date.now() + 4 * 60 * 60 * 1000,
    leverage:          LEVERAGE,
    synced:            false,
  };

  activeOrders.set(signalId, orderData);
  saveActive();

  console.log(`📋 LOCAL [${type}] ${symbol} @ ${entry} | R:R 2.5 | Risk: $${riskAmount.toFixed(2)} | Margin: $${marginRequired.toFixed(2)} | Available: $${availableBalance.toFixed(2)}`);

  return {
    success:        true,
    signalId,
    symbol,
    entryPrice:     entry,
    sl, tp,
    quantity:       qty,
    local:          true,
    riskAmount:     parseFloat(riskAmount.toFixed(2)),
    potentialProfit,
    potentialLoss,
    marginRequired,
    availableBalance: parseFloat(availableBalance.toFixed(2)),
  };
}

// ─── CLOSE LOCAL (Simulation) ─────────────────────────────────────────
// Προσομοιώνει MEXC: PnL = raw price move - openFee - closeFee

export function closeLocalOrder(signalId, reason, closePrice) {
  const order = activeOrders.get(signalId);
  if (!order || order.status !== 'open_local') return;

  const cp          = parseFloat(closePrice) || order.entryPrice;
  const cs          = order.contractSize || 0.001;
  const qty         = order.quantity || 1;
  const isLong      = order.side === 'BUY';

  // ── Raw PnL από κίνηση τιμής ─────────────────────────────────────────
  const rawPnl = isLong
    ? (cp - order.entryPrice) * qty * cs
    : (order.entryPrice - cp) * qty * cs;

  // ── MEXC Fees ────────────────────────────────────────────────────────
  // Άνοιγμα: maker fee (0.02%) — κλείσιμο: market fee (0.06%) αν SL/TP hit
  const closeNotional = qty * cs * cp;
  const openFee   = order.openFee || (qty * cs * order.entryPrice * MAKER_FEE);
  const closeFee  = closeNotional * (reason === 'manual_close' ? MAKER_FEE : TAKER_FEE);
  const totalFees = openFee + closeFee;

  const pnl     = parseFloat((rawPnl - totalFees).toFixed(4));

  // ── PnL% βάσει margin που δεσμεύτηκε ────────────────────────────────
  const margin  = order.marginRequired || (qty * cs * order.entryPrice / LEVERAGE);
  const pnlPct  = margin > 0 ? parseFloat(((pnl / margin) * 100).toFixed(2)) : 0;

  const result  = pnl > 0 ? 'won' : pnl < 0 ? 'lost' : 'manual_close';

  const closed = {
    ...order,
    closeTime:   Date.now(),
    closePrice:  cp,
    closeReason: reason,
    result,
    rawPnl:      parseFloat(rawPnl.toFixed(4)),
    fees:        parseFloat(totalFees.toFixed(4)),
    openFee:     parseFloat(openFee.toFixed(4)),
    closeFee:    parseFloat(closeFee.toFixed(4)),
    pnl,
    pnlPct,
    duration:    Date.now() - order.openTime,
    isLocal:     true,
  };

  localHistory.unshift(closed);
  if (localHistory.length > 500) localHistory.pop();
  saveLocalHistory();

  activeOrders.delete(signalId);
  saveActive();

  console.log(`📋 LOCAL CLOSE ${order.symbol} (${reason}) rawPnL: $${rawPnl.toFixed(4)} fees: $${totalFees.toFixed(4)} netPnL: $${pnl.toFixed(4)} [${result}]`);
}

// ─── SEND TO MEXC ─────────────────────────────────────────────────────
// Παίρνει μια τοπική εντολή και την αποστέλλει στο MEXC

export async function sendOrderToMEXC(signalId) {
  const order = activeOrders.get(signalId);
  if (!order) return { success: false, error: 'Δεν βρέθηκε η εντολή' };
  if (!order.isLocal) return { success: false, error: 'Η εντολή έχει ήδη σταλεί στο MEXC' };

  try {
    // 1. Πραγματικό balance από MEXC
    const balance = await getUsdtBalance();
    if (balance < 10) throw new Error(`Ανεπαρκές balance: $${balance.toFixed(2)}`);

    // 2. Symbol info
    const info = await fetchSymbolInfo(order.symbol);
    const { tickSize, contractSize, minVol } = info;

    // 3. Υπολογισμός πραγματικής ποσότητας
    const qty = calculatePositionSize(balance, getRisk(), order.entryPrice, order.sl, contractSize, LEVERAGE);
    if (qty < minVol) throw new Error(`Qty ${qty} < minVol ${minVol}`);

    // 4. LIMIT order στο MEXC
    const limitOrder = await placeLimitOrder({
      symbol:   order.symbol,
      side:     order.side,
      price:    roundTick(order.entryPrice, tickSize),
      quantity: qty,
      leverage: LEVERAGE,
    });

    // 5. Ενημέρωση εντολής → real MEXC mode
    const riskAmount      = balance * getRisk() / 100;
    order.sentToMEXC      = true;
    order.isLocal         = false;
    order.status          = 'pending_fill';
    order.limitOrderId    = limitOrder.orderId;
    order.mexcSentAt      = Date.now();
    order.quantity        = qty;
    order.contractSize    = contractSize;
    order.riskAmount      = parseFloat(riskAmount.toFixed(2));
    order.potentialProfit = parseFloat((riskAmount * 2.5).toFixed(2));
    order.potentialLoss   = parseFloat(riskAmount.toFixed(2));
    order.positionSize    = parseFloat((qty * contractSize * order.entryPrice).toFixed(2));

    activeOrders.set(signalId, order);
    saveActive();

    console.log(`✅ Εντολή στάλθηκε στο MEXC! ${order.symbol} LIMIT @ ${order.entryPrice} | ID: ${limitOrder.orderId}`);
    return { success: true, orderId: limitOrder.orderId, symbol: order.symbol };

  } catch (err) {
    console.error(`❌ sendOrderToMEXC ${order?.symbol}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ─── REAL MEXC: CHECK FILL ────────────────────────────────────────────

export async function checkOrderFilled(signalId) {
  const order = activeOrders.get(signalId);
  if (!order || order.status !== 'pending_fill') return;

  try {
    const status = await getOrderStatus(order.symbol, order.limitOrderId);

    if (status.status === 'FILLED') {
      const actualEntry    = parseFloat(status.avgPrice || status.price || order.entryPrice);
      order.status         = 'open';
      order.openTime       = Date.now();
      order.entryPrice     = actualEntry;
      activeOrders.set(signalId, order);
      saveActive();
      console.log(`✅ MEXC LIMIT γέμισε! ${order.symbol} @ ${actualEntry}`);
      return 'filled';
    }

    if (Date.now() > order.expireAt) {
      await cancelOrder(order.symbol, order.limitOrderId).catch(() => {});
      const expired = { ...order, status: 'expired', closeTime: Date.now(), closeReason: 'expired_4h', result: 'expired' };
      tradeHistory.unshift(expired);
      if (tradeHistory.length > 500) tradeHistory.pop();
      saveHistory();
      activeOrders.delete(signalId);
      saveActive();
      console.log(`⏰ MEXC order ${order.symbol} έληξε`);
      return 'expired';
    }

  } catch (err) {
    console.error(`⚠️ checkOrderFilled ${order.symbol}:`, err.message);
  }
}

// ─── REAL MEXC: SL/TP CLOSE ───────────────────────────────────────────

export async function checkAndCloseSLTP(signalId, reason, closePrice) {
  const order = activeOrders.get(signalId);
  if (!order || order.status !== 'open') return;

  try {
    console.log(`\n🔔 MEXC ${reason} HIT! Κλείσιμο ${order.symbol} @ ${closePrice}`);
    await closePositionMarket(order.symbol, order.side, order.quantity);

    const isLong = order.side === 'BUY';
    const cs     = order.contractSize || 0.001;
    const pnl    = isLong
      ? (closePrice - order.entryPrice) * order.quantity * cs
      : (order.entryPrice - closePrice) * order.quantity * cs;
    const pnlPct = (pnl / (order.entryPrice * order.quantity * cs / LEVERAGE)) * 100;

    const closed = {
      ...order,
      closeTime:   Date.now(),
      closePrice,
      closeReason: reason,
      result:      reason === 'TP' ? 'won' : 'lost',
      pnl:         parseFloat(pnl.toFixed(4)),
      pnlPct:      parseFloat(pnlPct.toFixed(3)),
      duration:    Date.now() - order.openTime,
      isLocal:     false,
    };

    tradeHistory.unshift(closed);
    if (tradeHistory.length > 500) tradeHistory.pop();
    saveHistory();
    activeOrders.delete(signalId);
    saveActive();

    console.log(`✅ MEXC ${order.symbol} κλείστηκε (${reason}) PnL: $${pnl.toFixed(2)}\n`);
  } catch (err) {
    console.error(`❌ MEXC close ${order.symbol}:`, err.message);
  }
}

// ─── MANUAL CANCEL/CLOSE ──────────────────────────────────────────────

export async function cancelSignalOrders(signalId, currentPrice) {
  const order = activeOrders.get(signalId);
  if (!order) return { success: false, error: 'Δεν βρέθηκε' };

  try {
    if (order.isLocal || order.status === 'open_local') {
      // Τοπικό κλείσιμο
      closeLocalOrder(signalId, 'manual_close', currentPrice || order.entryPrice);
    } else if (order.status === 'pending_fill') {
      await cancelOrder(order.symbol, order.limitOrderId);
      tradeHistory.unshift({ ...order, closeTime: Date.now(), closeReason: 'manual_cancel', result: 'cancelled', pnl: 0 });
      if (tradeHistory.length > 500) tradeHistory.pop();
      saveHistory();
      activeOrders.delete(signalId);
      saveActive();
    } else if (order.status === 'open') {
      try { await cancelAllOrders(order.symbol); } catch {}
      await closePositionMarket(order.symbol, order.side, order.quantity);
      const cp     = currentPrice || order.entryPrice;
      const isLong = order.side === 'BUY';
      const cs     = order.contractSize || 0.001;
      const pnl    = isLong
        ? (cp - order.entryPrice) * order.quantity * cs
        : (order.entryPrice - cp) * order.quantity * cs;
      tradeHistory.unshift({ ...order, closeTime: Date.now(), closePrice: cp, closeReason: 'manual_close', result: 'manual_close', pnl: parseFloat(pnl.toFixed(4)) });
      if (tradeHistory.length > 500) tradeHistory.pop();
      saveHistory();
      activeOrders.delete(signalId);
      saveActive();
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── CANCEL ALL ───────────────────────────────────────────────────────

export async function cancelAllSignalOrders() {
  const all = Array.from(activeOrders.values());
  const results = [];

  for (const o of all) {
    try {
      if (o.isLocal || o.status === 'open_local') {
        closeLocalOrder(o.signalId, 'panic', o.entryPrice);
      } else if (o.status === 'pending_fill') {
        await cancelOrder(o.symbol, o.limitOrderId).catch(() => {});
        tradeHistory.unshift({ ...o, closeTime: Date.now(), closeReason: 'panic', result: 'manual_close', pnl: 0 });
        activeOrders.delete(o.signalId);
      } else {
        await cancelAllOrders(o.symbol).catch(() => {});
        await closePositionMarket(o.symbol, o.side, o.quantity);
        tradeHistory.unshift({ ...o, closeTime: Date.now(), closeReason: 'panic', result: 'manual_close', pnl: 0 });
        activeOrders.delete(o.signalId);
      }
      results.push({ symbol: o.symbol, done: true });
    } catch (err) {
      results.push({ symbol: o.symbol, done: false, error: err.message });
    }
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

    for (const [id, o] of activeOrders.entries()) {
      if (o.status === 'open' && !symbols.has(o.symbol)) {
        console.log(`🔒 MEXC θέση ${o.symbol} έκλεισε εξωτερικά`);
        tradeHistory.unshift({ ...o, closeTime: Date.now(), closeReason: 'external', result: 'unknown', pnl: 0 });
        activeOrders.delete(id);
      }
    }

    for (const pos of positions) {
      const exists = Array.from(activeOrders.values())
        .find(o => o.symbol === pos.symbol && o.status === 'open');
      if (!exists) {
        const amt  = parseFloat(pos.positionAmt);
        const side = amt > 0 ? 'BUY' : 'SELL';
        const id   = `sync_${pos.symbol}_${Date.now()}`;
        activeOrders.set(id, {
          signalId: id, symbol: pos.symbol, quantity: Math.abs(amt),
          contractSize: 0.001, side, type: side === 'BUY' ? 'BULLISH' : 'BEARISH',
          entryPrice: parseFloat(pos.entryPrice), sl: 0, tp: 0, rr: 2.5,
          riskAmount: 0, limitOrderId: null, status: 'open',
          isLocal: false, sentToMEXC: true,
          openTime: Date.now(), placedAt: Date.now(),
          leverage: parseInt(pos.leverage || 10), synced: true,
        });
        console.log(`🔄 Sync MEXC: ${pos.symbol} ${side}`);
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

export function getLocalHistory() {
  return localHistory;
}

export function getStats() {
  return _calcStats(tradeHistory);
}

export function getLocalStats() {
  return _calcStats(localHistory);
}

function _calcStats(history) {
  // Συμπεριλαμβάνουμε όλα τα κλειστά trades (won, lost, manual_close)
  const closed   = history.filter(t => t.result === 'won' || t.result === 'lost' || t.result === 'manual_close');
  const won      = closed.filter(t => t.pnl > 0);
  const lost     = closed.filter(t => t.pnl < 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const winRate  = closed.length > 0 ? (won.length / closed.length) * 100 : 0;

  let peak = 0, maxDrawdown = 0, running = 0;
  for (const t of [...history].reverse()) {
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
    if (o.symbol === symbol && ['open', 'open_local', 'pending_fill'].includes(o.status)) {
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

// ─── RESET SIMULATION ─────────────────────────────────────────────────
// Σβήνει όλες τις paper θέσεις και το history — φρέσκο ξεκίνημα

export function resetSimulation() {
  // Κρατά μόνο real MEXC orders (isLocal = false)
  for (const [id, order] of activeOrders.entries()) {
    if (order.isLocal) activeOrders.delete(id);
  }
  localHistory.length = 0;
  saveActive();
  saveLocalHistory();
  console.log('🔄 Simulation reset — νέο ξεκίνημα με $' + getSimBalance());
  return { success: true, message: `Simulation reset. Νέο balance: $${getSimBalance()}` };
}
