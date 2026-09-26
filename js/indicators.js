/*
 * Technische Indikatoren. Alle Funktionen liefern Arrays gleicher Länge wie die
 * Eingabe; Werte, die (noch) nicht berechenbar sind, sind `null`.
 */
(function (root) {
  'use strict';

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let prev = null;
    let seed = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined) continue;
      if (prev === null) {
        seed += v;
        count++;
        if (count === period) {
          prev = seed / period;
          out[i] = prev;
        }
      } else {
        prev = v * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  // Wilder-Glättung (RMA), genutzt von RSI, ATR und ADX.
  function rma(values, period) {
    const out = new Array(values.length).fill(null);
    let prev = null;
    let seed = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined) continue;
      if (prev === null) {
        seed += v;
        count++;
        if (count === period) {
          prev = seed / period;
          out[i] = prev;
        }
      } else {
        prev = (prev * (period - 1) + v) / period;
        out[i] = prev;
      }
    }
    return out;
  }

  function rsi(closes, period = 14) {
    const gains = [null];
    const losses = [null];
    for (let i = 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      gains.push(Math.max(d, 0));
      losses.push(Math.max(-d, 0));
    }
    const ag = rma(gains, period);
    const al = rma(losses, period);
    return closes.map((_, i) => {
      if (ag[i] === null || al[i] === null) return null;
      if (al[i] === 0) return ag[i] === 0 ? 50 : 100;
      return 100 - 100 / (1 + ag[i] / al[i]);
    });
  }

  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const line = closes.map((_, i) => (ef[i] !== null && es[i] !== null ? ef[i] - es[i] : null));
    const sig = ema(line, signal);
    const hist = line.map((v, i) => (v !== null && sig[i] !== null ? v - sig[i] : null));
    return { line, signal: sig, hist };
  }

  function stdev(values, period) {
    const out = new Array(values.length).fill(null);
    const mean = sma(values, period);
    for (let i = period - 1; i < values.length; i++) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += (values[j] - mean[i]) ** 2;
      out[i] = Math.sqrt(s / period);
    }
    return out;
  }

  function bollinger(closes, period = 20, mult = 2) {
    const mid = sma(closes, period);
    const sd = stdev(closes, period);
    const upper = mid.map((m, i) => (m === null ? null : m + mult * sd[i]));
    const lower = mid.map((m, i) => (m === null ? null : m - mult * sd[i]));
    const percentB = closes.map((c, i) =>
      upper[i] === null || upper[i] === lower[i] ? null : (c - lower[i]) / (upper[i] - lower[i])
    );
    const bandwidth = mid.map((m, i) => (m === null ? null : (upper[i] - lower[i]) / m));
    return { mid, upper, lower, percentB, bandwidth };
  }

  function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3, smooth = 3) {
    const raw = new Array(closes.length).fill(null);
    for (let i = kPeriod - 1; i < closes.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) {
        hh = Math.max(hh, highs[j]);
        ll = Math.min(ll, lows[j]);
      }
      raw[i] = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    }
    const k = smaNullable(raw, smooth);
    const d = smaNullable(k, dPeriod);
    return { k, d };
  }

  function smaNullable(values, period) {
    const out = new Array(values.length).fill(null);
    for (let i = period - 1; i < values.length; i++) {
      let s = 0;
      let ok = true;
      for (let j = i - period + 1; j <= i; j++) {
        if (values[j] === null) { ok = false; break; }
        s += values[j];
      }
      if (ok) out[i] = s / period;
    }
    return out;
  }

  function trueRange(highs, lows, closes) {
    return closes.map((_, i) => {
      if (i === 0) return highs[0] - lows[0];
      return Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
    });
  }

  function atr(highs, lows, closes, period = 14) {
    return rma(trueRange(highs, lows, closes), period);
  }

  function adx(highs, lows, closes, period = 14) {
    const n = closes.length;
    const plusDM = [null];
    const minusDM = [null];
    for (let i = 1; i < n; i++) {
      const up = highs[i] - highs[i - 1];
      const down = lows[i - 1] - lows[i];
      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);
    }
    const tr = trueRange(highs, lows, closes);
    tr[0] = null;
    const str = rma(tr, period);
    const sp = rma(plusDM, period);
    const sm = rma(minusDM, period);
    const plusDI = str.map((t, i) => (t ? (100 * sp[i]) / t : null));
    const minusDI = str.map((t, i) => (t ? (100 * sm[i]) / t : null));
    const dx = plusDI.map((p, i) => {
      if (p === null || minusDI[i] === null) return null;
      const s = p + minusDI[i];
      return s === 0 ? 0 : (100 * Math.abs(p - minusDI[i])) / s;
    });
    return { adx: rma(dx, period), plusDI, minusDI };
  }

  function roc(closes, period = 10) {
    return closes.map((c, i) => (i < period ? null : ((c - closes[i - period]) / closes[i - period]) * 100));
  }

  // Swing-Hochs/-Tiefs: Bar ist höher/tiefer als `span` Bars links und rechts.
  function pivots(highs, lows, span = 3) {
    const highsIdx = [];
    const lowsIdx = [];
    for (let i = span; i < highs.length - span; i++) {
      let isHigh = true;
      let isLow = true;
      for (let j = 1; j <= span; j++) {
        if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isHigh = false;
        if (lows[i] >= lows[i - j] || lows[i] >= lows[i + j]) isLow = false;
      }
      if (isHigh) highsIdx.push(i);
      if (isLow) lowsIdx.push(i);
    }
    return { highs: highsIdx, lows: lowsIdx };
  }

  const Indicators = { sma, ema, rma, rsi, macd, stdev, bollinger, stochastic, atr, adx, roc, pivots };

  if (typeof module !== 'undefined' && module.exports) module.exports = Indicators;
  else root.Indicators = Indicators;
})(typeof self !== 'undefined' ? self : this);
