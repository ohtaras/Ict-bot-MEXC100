/**
 * ictEngine.js — ICT Core Strategy
 * Liquidity Sweep → Market Structure Shift (MSS) → Fair Value Gap (FVG)
 * 100% ίδιο με το original TypeScript
 */

import { randomUUID } from 'crypto';

export function generateId() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export function ictCoreEngine(candles, pair, rrRatio = 1) {
  if (candles.length < 30) return [];

  const signals     = [];
  const usedIndices = new Set();

  // Rolling 24-period high/low
  const prevHigh = [];
  const prevLow  = [];

  for (let i = 0; i < candles.length; i++) {
    if (i < 24) {
      prevHigh.push(null);
      prevLow.push(null);
      continue;
    }
    let maxH = -Infinity;
    let minL =  Infinity;
    for (let k = i - 24; k < i; k++) {
      if (candles[k].high > maxH) maxH = candles[k].high;
      if (candles[k].low  < minL) minL = candles[k].low;
    }
    prevHigh.push(maxH);
    prevLow.push(minL);
  }

  for (let i = 25; i < candles.length; i++) {
    if (prevHigh[i] === null || prevLow[i] === null) continue;

    const currentClose = candles[i].close;
    const currentLow   = candles[i].low;
    const currentHigh  = candles[i].high;
    const pHigh = prevHigh[i];
    const pLow  = prevLow[i];

    // ─── BULLISH SETUP ────────────────────────────────────────────────
    // A. Liquidity Sweep: τιμή πέφτει κάτω από previous low, κλείνει πάνω
    if (currentLow < pLow && currentClose > pLow) {

      for (let j = i + 1; j < Math.min(i + 10, candles.length); j++) {
        if (usedIndices.has(j)) continue;

        // B. MSS: κερί κλείνει πάνω από high του sweep candle
        if (candles[j].close > candles[i].high) {

          // C. FVG: gap μεταξύ low[j] και high[j-2]
          if (j >= 2 && candles[j].low > candles[j - 2].high) {
            const entryPrice = candles[j].low;
            const sl = currentLow - (currentLow * 0.001);
            const tp = entryPrice + (entryPrice - sl) * rrRatio;

            signals.push({
              id:          generateId(),
              pair,
              type:        'BULLISH',
              side:        'BUY',
              entry:       parseFloat(entryPrice.toPrecision(8)),
              sl:          parseFloat(sl.toPrecision(8)),
              tp:          parseFloat(tp.toPrecision(8)),
              rr:          rrRatio,
              timestamp:   candles[j].time,
              detectedAt:  Date.now(),
              status:      'pending',
              expireAt:    Date.now() + (4 * 60 * 60 * 1000), // 4h expiry
            });
            usedIndices.add(j);
            break;
          }
        }
      }

    // ─── BEARISH SETUP ────────────────────────────────────────────────
    // A. Liquidity Sweep: τιμή ανεβαίνει πάνω από previous high, κλείνει κάτω
    } else if (currentHigh > pHigh && currentClose < pHigh) {

      for (let j = i + 1; j < Math.min(i + 10, candles.length); j++) {
        if (usedIndices.has(j)) continue;

        // B. MSS: κερί κλείνει κάτω από low του sweep candle
        if (candles[j].close < candles[i].low) {

          // C. FVG: gap μεταξύ high[j] και low[j-2]
          if (j >= 2 && candles[j].high < candles[j - 2].low) {
            const entryPrice = candles[j].high;
            const sl = currentHigh + (currentHigh * 0.001);
            const tp = entryPrice - (sl - entryPrice) * rrRatio;

            signals.push({
              id:          generateId(),
              pair,
              type:        'BEARISH',
              side:        'SELL',
              entry:       parseFloat(entryPrice.toPrecision(8)),
              sl:          parseFloat(sl.toPrecision(8)),
              tp:          parseFloat(Math.max(0, tp).toPrecision(8)),
              rr:          rrRatio,
              timestamp:   candles[j].time,
              detectedAt:  Date.now(),
              status:      'pending',
              expireAt:    Date.now() + (4 * 60 * 60 * 1000), // 4h expiry
            });
            usedIndices.add(j);
            break;
          }
        }
      }
    }
  }

  return signals;
}

/**
 * Έλεγχος αν η τιμή μπήκε στη FVG ζώνη → trigger
 */
export function checkSignalTrigger(signal, currentPrice) {
  if (signal.status !== 'pending') return false;

  // Έλεγχος expiry (4 ώρες)
  if (signal.expireAt && Date.now() > signal.expireAt) return false;

  if (signal.type === 'BULLISH') {
    // Τιμή πέφτει στη FVG ζώνη
    return currentPrice <= signal.entry * 1.002 && currentPrice >= signal.sl;
  } else {
    // Τιμή ανεβαίνει στη FVG ζώνη
    return currentPrice >= signal.entry * 0.998 && currentPrice <= signal.sl;
  }
}

/**
 * Έλεγχος αν signal έχει λήξει (4h)
 */
export function isSignalExpired(signal) {
  if (!signal.expireAt) return false;
  return Date.now() > signal.expireAt;
}

/**
 * Software SL/TP check για ανοιχτές θέσεις
 */
export function checkTradeExit(side, currentPrice, sl, tp) {
  const isLong = side === 'BUY';
  if (isLong) {
    if (currentPrice >= tp) return 'TP';
    if (currentPrice <= sl) return 'SL';
  } else {
    if (currentPrice <= tp) return 'TP';
    if (currentPrice >= sl) return 'SL';
  }
  return null;
}
