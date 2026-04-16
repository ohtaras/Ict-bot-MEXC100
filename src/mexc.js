/**
 * mexc.js — MEXC FUTURES CONTRACT API
 * LIMIT entry + Software SL/TP + Full Analytics
 * Base URL: https://contract.mexc.com
 */

import crypto from 'crypto';
import fetch  from 'node-fetch';

const BASE_URL = 'https://contract.mexc.com';

// ─── SYMBOL FORMAT ────────────────────────────────────────────────────
// MEXC Futures χρησιμοποιεί BTC_USDT (με underscore)
// Το UI και το ictEngine χρησιμοποιούν BTCUSDT

export function toMexcSymbol(symbol) {
  if (symbol.includes('_')) return symbol;
  for (const quote of ['USDT', 'USDC', 'BTC', 'ETH']) {
    if (symbol.endsWith(quote)) {
      return symbol.slice(0, -quote.length) + '_' + quote;
    }
  }
  return symbol;
}

export function fromMexcSymbol(symbol) {
  return symbol.replace('_', '');
}

// ─── AUTH ─────────────────────────────────────────────────────────────
// Signature = HmacSHA256(ApiKey + Timestamp + RequestParam, SecretKey)
// RequestParam: query string για GET, JSON body string για POST/DELETE

function sign(message) {
  return crypto
    .createHmac('sha256', process.env.MEXC_SECRET_KEY)
    .update(message)
    .digest('hex');
}

function buildHeaders(requestParam = '') {
  const timestamp = Date.now().toString();
  const toSign    = process.env.MEXC_API_KEY + timestamp + requestParam;
  return {
    'ApiKey':       process.env.MEXC_API_KEY,
    'Request-Time': timestamp,
    'Signature':    sign(toSign),
    'Content-Type': 'application/json',
  };
}

// ─── INTERVAL MAP ─────────────────────────────────────────────────────

const INTERVAL_MAP = {
  '1m':  'Min1',
  '5m':  'Min5',
  '15m': 'Min15',
  '30m': 'Min30',
  '1h':  'Min60',
  '4h':  'Hour4',
  '8h':  'Hour8',
  '1d':  'Day1',
  '1w':  'Week1',
};

// ─── PUBLIC ───────────────────────────────────────────────────────────

export async function fetchPrice(symbol) {
  const mx  = toMexcSymbol(symbol);
  const res = await fetch(`${BASE_URL}/api/v1/contract/ticker?symbol=${mx}`);
  if (!res.ok) throw new Error(`fetchPrice failed: ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error(`fetchPrice error: ${d.message}`);
  return {
    price:     parseFloat(d.data.lastPrice),
    change24h: parseFloat(d.data.priceChangeRate || 0) * 100,
  };
}

export async function fetchCandles(symbol, interval = '1h', limit = 200) {
  const mx          = toMexcSymbol(symbol);
  const mexcInterval = INTERVAL_MAP[interval] || 'Min60';
  const res = await fetch(
    `${BASE_URL}/api/v1/contract/kline/${mx}?interval=${mexcInterval}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`fetchCandles failed: ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error(`fetchCandles error: ${d.message}`);

  // MEXC επιστρέφει arrays (όχι array of objects)
  const data = d.data;
  const len  = data.time?.length || 0;
  const candles = [];
  for (let i = 0; i < len; i++) {
    candles.push({
      time:   data.time[i] * 1000,          // seconds → ms
      open:   parseFloat(data.open[i]),
      high:   parseFloat(data.high[i]),
      low:    parseFloat(data.low[i]),
      close:  parseFloat(data.close[i]),
      volume: parseFloat(data.vol[i] || 0),
    });
  }
  return candles;
}

export async function fetchSymbolInfo(symbol) {
  const mx  = toMexcSymbol(symbol);
  const res = await fetch(`${BASE_URL}/api/v1/contract/detail?symbol=${mx}`);
  if (!res.ok) throw new Error(`fetchSymbolInfo failed: ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error(`fetchSymbolInfo error: ${d.message}`);
  const info         = d.data;
  const contractSize = parseFloat(info.contractSize || '0.001');
  const priceScale   = info.priceScale || 2;
  const tickSize     = Math.pow(10, -priceScale);
  return {
    symbol,
    mexcSymbol:        mx,
    contractSize,
    priceScale,
    volScale:          info.volScale  || 0,
    minVol:            parseFloat(info.minVol || '1'),
    tickSize,
    stepSize:          contractSize,   // compat alias
    minQty:            parseFloat(info.minVol || '1'),
    pricePrecision:    priceScale,
    quantityPrecision: info.volScale  || 0,
  };
}

// ─── PRIVATE ──────────────────────────────────────────────────────────

export async function fetchAccountInfo() {
  const headers = buildHeaders();
  const res = await fetch(`${BASE_URL}/api/v1/private/account/assets`, { headers });
  if (!res.ok) throw new Error(`fetchAccountInfo failed: ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error(`fetchAccountInfo error: ${d.message}`);

  // Επιστρέφουμε σε Binance-compatible format
  const assets = (d.data || []).map(a => ({
    asset:            a.currency,
    walletBalance:    a.cashBalance       || '0',
    availableBalance: a.availableBalance  || '0',
    unrealizedProfit: a.unrealized        || '0',
    // original MEXC fields
    ...a,
  }));
  const totalUnrealized = assets.reduce((s, a) => s + parseFloat(a.unrealized || 0), 0);
  return {
    assets,
    totalUnrealizedProfit: totalUnrealized.toString(),
  };
}

export async function getUsdtBalance() {
  const account = await fetchAccountInfo();
  const usdt    = account.assets.find(a => a.asset === 'USDT');
  const bal     = parseFloat(usdt?.availableBalance || 0);
  console.log(`   💵 Available USDT: $${bal.toFixed(2)}`);
  return bal;
}

export async function fetchPositions(symbol) {
  const query   = symbol ? `?symbol=${toMexcSymbol(symbol)}` : '';
  const param   = query.slice(1);
  const headers = buildHeaders(param);
  const res = await fetch(`${BASE_URL}/api/v1/private/position/open_positions${query}`, { headers });
  if (!res.ok) throw new Error(`fetchPositions failed: ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error(`fetchPositions error: ${d.message}`);

  // Map σε Binance-compatible format
  return (d.data || []).map(pos => {
    const isLong   = pos.positionType === 1;
    const holdVol  = parseFloat(pos.holdVol || 0);
    const posAmt   = isLong ? holdVol : -holdVol;
    return {
      symbol:            fromMexcSymbol(pos.symbol),
      mexcSymbol:        pos.symbol,
      positionAmt:       posAmt,
      entryPrice:        pos.openAvgPrice  || '0',
      markPrice:         pos.markPrice     || pos.openAvgPrice || '0',
      unRealizedProfit:  pos.unrealised    || pos.unrealizedValue || '0',
      leverage:          pos.leverage      || 10,
      positionType:      pos.positionType,
      holdVol,
      ...pos,
    };
  });
}

export async function fetchOpenOrders(symbol) {
  const mx      = toMexcSymbol(symbol);
  const param   = `symbol=${mx}`;
  const headers = buildHeaders(param);
  const res = await fetch(`${BASE_URL}/api/v1/private/order/open_orders/${mx}`, { headers });
  if (!res.ok) throw new Error(`fetchOpenOrders failed: ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error(`fetchOpenOrders error: ${d.message}`);
  return d.data?.resultList || [];
}

/**
 * History από closed orders — αντικαθιστά το fetchIncomeHistory της Binance
 * MEXC states: 2=filled, 3=partially filled, 4=cancelled
 */
export async function fetchIncomeHistory({ limit = 200 } = {}) {
  const param   = `pageSize=${limit}&states=2`;
  const headers = buildHeaders(param);
  const res = await fetch(
    `${BASE_URL}/api/v1/private/order/list/history_orders?pageSize=${limit}&states=2`,
    { headers }
  );
  if (!res.ok) throw new Error(`fetchIncomeHistory failed: ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error(`fetchIncomeHistory error: ${d.message}`);
  return d.data?.resultList || [];
}

/**
 * Πλήρες analytics από MEXC
 */
export async function fetchBinanceAnalytics(initialBalance = 10000) {
  try {
    // 1. Τρέχον balance
    const account = await fetchAccountInfo();
    const usdt    = account.assets.find(a => a.asset === 'USDT');
    const currentBalance = parseFloat(usdt?.cashBalance || usdt?.equity || 0);
    const unrealizedPnl  = parseFloat(usdt?.unrealized  || 0);

    // 2. Closed orders ως PnL history
    const orders = await fetchIncomeHistory({ limit: 500 });
    const trades = orders.map(o => ({
      symbol:  fromMexcSymbol(o.symbol || ''),
      pnl:     parseFloat(o.closeProfit || o.dealValue || 0),
      time:    o.updateTime || o.createTime || Date.now(),
      tradeId: o.orderId,
    })).filter(t => t.pnl !== 0);

    const wonTrades  = trades.filter(t => t.pnl > 0);
    const lostTrades = trades.filter(t => t.pnl < 0);
    const totalPnl   = trades.reduce((s, t) => s + t.pnl, 0);

    const grossProfit  = wonTrades.reduce((s, t) => s + t.pnl, 0);
    const grossLoss    = Math.abs(lostTrades.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : 0;
    const winRate      = trades.length > 0
      ? parseFloat(((wonTrades.length / trades.length) * 100).toFixed(1))
      : 0;

    // 3. Max Drawdown + Equity Curve
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

    // 4. Ομαδοποίηση ανά ημέρα
    const dayGroups = {};
    for (const t of sortedTrades) {
      const day = new Date(t.time).toLocaleDateString('el-GR', {
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
      });
      if (!dayGroups[day]) dayGroups[day] = { trades: [], pnl: 0, won: 0, lost: 0 };
      dayGroups[day].trades.push(t);
      dayGroups[day].pnl += t.pnl;
      if (t.pnl > 0) dayGroups[day].won++;
      else dayGroups[day].lost++;
    }

    return {
      currentBalance,
      unrealizedPnl:    parseFloat(unrealizedPnl.toFixed(2)),
      totalPnl:         parseFloat(totalPnl.toFixed(2)),
      totalFunding:     0,
      totalCommissions: 0,
      netPnl:           parseFloat(totalPnl.toFixed(2)),
      totalTrades:      trades.length,
      won:              wonTrades.length,
      lost:             lostTrades.length,
      winRate,
      profitFactor,
      maxDrawdown:      parseFloat(maxDrawdown.toFixed(1)),
      equity,
      dayGroups,
      trades:           sortedTrades.reverse(),
    };

  } catch (err) {
    console.error('fetchMexcAnalytics error:', err.message);
    throw err;
  }
}

export async function cancelOrder(symbol, orderId) {
  const body    = JSON.stringify({ symbol: toMexcSymbol(symbol), orderId });
  const headers = buildHeaders(body);
  const res = await fetch(`${BASE_URL}/api/v1/private/order/cancel`, {
    method:  'DELETE',
    headers,
    body,
  });
  if (!res.ok) throw new Error(`cancelOrder failed: ${res.status}`);
  const d = await res.json();
  if (!d.success && d.code !== 0) throw new Error(`cancelOrder error: ${d.message}`);
  return d;
}

export async function cancelAllOrders(symbol) {
  try {
    const openOrders = await fetchOpenOrders(symbol);
    if (!openOrders.length) return { msg: 'No open orders' };
    const orderIds = openOrders.map(o => o.orderId);
    const body     = JSON.stringify({ symbol: toMexcSymbol(symbol), orderIds });
    const headers  = buildHeaders(body);
    const res = await fetch(`${BASE_URL}/api/v1/private/order/cancel`, {
      method:  'DELETE',
      headers,
      body,
    });
    const d = await res.json();
    return d;
  } catch (err) {
    console.error(`cancelAllOrders ${symbol}:`, err.message);
    return { msg: err.message };
  }
}

export async function closePositionMarket(symbol, side, vol) {
  // MEXC close sides: 4 = close long, 2 = close short
  const closeSide = side === 'BUY' ? 4 : 2;
  const mx        = toMexcSymbol(symbol);

  const body    = JSON.stringify({ symbol: mx, vol, side: closeSide, type: 5, openType: 1 });
  const headers = buildHeaders(body);

  const res = await fetch(`${BASE_URL}/api/v1/private/order/submit`, {
    method: 'POST',
    headers,
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`closePosition failed: ${data.message}`);
  console.log(`🔒 Κλείσιμο: ${mx} side:${closeSide} vol:${vol}`);
  return data;
}

export async function setLeverage(symbol, leverage = 10) {
  // Για MEXC το leverage ορίζεται μέσα στο order — αυτό το καλούμε προαιρετικά
  console.log(`⚙️  Leverage: ${toMexcSymbol(symbol)} → ${leverage}x (per-order)`);
  return { success: true };
}

export async function setMarginType(symbol, marginType = 'ISOLATED') {
  // Για MEXC το openType ορίζεται μέσα στο order (1=isolated, 2=cross)
  return { success: true };
}

function roundToPrecision(value, precision) {
  return parseFloat(value.toFixed(Math.max(0, precision)));
}

/**
 * MEXC: vol σε contracts
 * 1 contract = contractSize μονάδες base asset
 * PnL ανά contract ανά $1 κίνηση = contractSize
 * vol = riskAmount / (slDistance * contractSize)
 */
export function calculatePositionSize(balance, riskPercent, entry, stopLoss, contractSize, leverage = 10) {
  const riskAmount = balance * (riskPercent / 100);
  const slDistance = Math.abs(entry - stopLoss);
  if (slDistance === 0) throw new Error('Entry και SL ίδια τιμή');

  const rawVol    = riskAmount / (slDistance * contractSize);
  let   vol       = Math.max(1, Math.round(rawVol));

  // Έλεγχος margin
  const requiredMargin = (vol * contractSize * entry) / leverage;
  if (requiredMargin > balance * 0.9) {
    vol = Math.max(1, Math.floor((balance * 0.9 * leverage) / (contractSize * entry)));
  }
  return vol;
}

export async function placeLimitOrder({ symbol, side, price, quantity, leverage = 10 }) {
  const mx = toMexcSymbol(symbol);
  // MEXC sides: 1=open long (BUY), 3=open short (SELL)
  const mexcSide = side === 'BUY' ? 1 : 3;

  const body    = JSON.stringify({
    symbol:   mx,
    price,
    vol:      quantity,
    leverage,
    side:     mexcSide,
    type:     1,  // LIMIT
    openType: 1,  // ISOLATED margin
  });
  const headers = buildHeaders(body);

  const res = await fetch(`${BASE_URL}/api/v1/private/order/submit`, {
    method: 'POST',
    headers,
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`placeLimitOrder failed [${data.code}]: ${data.message}`);
  const orderId = data.data;
  console.log(`✅ LIMIT ${side}: ${quantity} contracts ${mx} @ ${price} | ID: ${orderId}`);
  return { orderId, ...data };
}

export async function placeMarketOrder({ symbol, side, quantity, leverage = 10 }) {
  const mx       = toMexcSymbol(symbol);
  const mexcSide = side === 'BUY' ? 1 : 3;

  const body    = JSON.stringify({ symbol: mx, vol: quantity, leverage, side: mexcSide, type: 5, openType: 1 });
  const headers = buildHeaders(body);

  const res = await fetch(`${BASE_URL}/api/v1/private/order/submit`, {
    method: 'POST',
    headers,
    body,
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(`placeMarketOrder failed [${data.code}]: ${data.message}`);
  console.log(`✅ MARKET ${side}: ${quantity} contracts ${mx}`);
  return { orderId: data.data, ...data };
}

export async function getOrderStatus(symbol, orderId) {
  const headers = buildHeaders();
  const res = await fetch(`${BASE_URL}/api/v1/private/order/get/${orderId}`, { headers });
  if (!res.ok) throw new Error(`getOrderStatus failed: ${res.status}`);
  const d = await res.json();
  if (!d.success) throw new Error(`getOrderStatus error: ${d.message}`);

  // MEXC order states: 1=pending, 2=filled, 3=partial, 4=cancelled
  const stateMap = { 1: 'NEW', 2: 'FILLED', 3: 'PARTIALLY_FILLED', 4: 'CANCELED' };
  return {
    ...d.data,
    status:   stateMap[d.data.state] || 'UNKNOWN',
    avgPrice: d.data.dealAvgPrice    || d.data.price,
  };
}

export async function ping() {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/contract/ping`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchAllSymbols() {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/contract/detail`);
    if (!res.ok) throw new Error(`fetchAllSymbols failed: ${res.status}`);
    const d = await res.json();
    if (!d.success || !Array.isArray(d.data)) return [];
    const symbols = d.data
      .filter(c => c.quoteCoin === 'USDT' && !c.isHidden)
      .map(c => fromMexcSymbol(c.symbol))
      .sort();
    console.log(`📊 MEXC symbols loaded: ${symbols.length}`);
    return symbols;
  } catch (e) {
    console.error('fetchAllSymbols error:', e.message);
    return [];
  }
}

// Γνωστά forex νομίσματα που διαπραγματεύονται ως futures στο MEXC
const FOREX_BASES = new Set([
  'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD',
  'SGD', 'HKD', 'MXN', 'TRY', 'ZAR', 'SEK', 'NOK',
  'DKK', 'PLN', 'CZK', 'HUF', 'BRL', 'INR',
]);

export async function fetchTopSymbolsByVolume(limit = 20) {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/contract/ticker`);
    if (!res.ok) throw new Error(`fetchTopSymbolsByVolume failed: ${res.status}`);
    const d = await res.json();
    if (!d.success || !Array.isArray(d.data)) return [];

    const usdtTickers = d.data.filter(t => t.symbol && t.symbol.endsWith('_USDT'));

    // Top N βάσει 24h volume σε $
    const sorted = [...usdtTickers].sort(
      (a, b) => parseFloat(b.amount24 || b.volume24 || 0) - parseFloat(a.amount24 || a.volume24 || 0)
    );
    const top = sorted.slice(0, limit).map(t => fromMexcSymbol(t.symbol));

    // Forex pairs (ό,τι υπάρχει στο MEXC)
    const forex = usdtTickers
      .map(t => fromMexcSymbol(t.symbol))
      .filter(s => {
        const base = s.replace('USDT', '');
        return FOREX_BASES.has(base);
      });

    // Ένωση χωρίς διπλότυπα
    const combined = [...new Set([...top, ...forex])];

    console.log(`📊 Top ${limit} by volume + ${forex.length} forex = ${combined.length} pairs: ${combined.join(', ')}`);
    return combined;
  } catch (e) {
    console.error('fetchTopSymbolsByVolume error:', e.message);
    return [];
  }
}
