/*
 * Signal-Engine: führt mehrere unabhängige Analysen durch und kombiniert sie
 * gewichtet zu einer Empfehlung (Strong Buy … Strong Sell).
 *
 * Jede Analyse liefert einen Score in [-1, +1] (+1 = bullish, -1 = bearish)
 * und eine kurze Begründung.
 */
(function (root) {
  'use strict';

  const I = typeof module !== 'undefined' && module.exports ? require('./indicators.js') : root.Indicators;

  const WEIGHTS = {
    trend: 2.0,
    macd: 1.5,
    adx: 1.5,
    rsi: 1.0,
    stoch: 1.0,
    bollinger: 1.0,
    sr: 1.0,
    momentum: 0.75,
    candle: 0.75,
  };

  const MIN_BARS = 60;

  const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
  const fmt = (v, d = 5) => (v === null || v === undefined ? '–' : v.toFixed(d));

  // Alle Indikatoren einmal für die gesamte Historie berechnen.
  function prepare(candles, digits = 5) {
    const o = candles.map((c) => c.open);
    const h = candles.map((c) => c.high);
    const l = candles.map((c) => c.low);
    const c = candles.map((c) => c.close);
    return {
      candles, o, h, l, c, digits,
      ema20: I.ema(c, 20),
      ema50: I.ema(c, 50),
      ema200: I.ema(c, 200),
      rsi: I.rsi(c, 14),
      macd: I.macd(c),
      bb: I.bollinger(c, 20, 2),
      stoch: I.stochastic(h, l, c),
      atr: I.atr(h, l, c, 14),
      adx: I.adx(h, l, c, 14),
      roc: I.roc(c, 10),
      pivots: I.pivots(h, l, 3),
    };
  }

  function trendAnalysis(x, i) {
    const p = x.c[i], e20 = x.ema20[i], e50 = x.ema50[i], e200 = x.ema200[i];
    if (e20 === null || e50 === null) return null;
    let s = 0;
    const why = [];
    if (p > e20) { s += 0.3; why.push('Kurs > EMA20'); } else { s -= 0.3; why.push('Kurs < EMA20'); }
    if (e20 > e50) { s += 0.4; why.push('EMA20 > EMA50'); } else { s -= 0.4; why.push('EMA20 < EMA50'); }
    if (e200 !== null) {
      if (p > e200) { s += 0.3; why.push('über EMA200'); } else { s -= 0.3; why.push('unter EMA200'); }
    }
    const prev20 = x.ema20[i - 1], prev50 = x.ema50[i - 1];
    if (prev20 !== null && prev50 !== null) {
      if (prev20 <= prev50 && e20 > e50) why.push('Golden Cross (EMA20/50)!');
      if (prev20 >= prev50 && e20 < e50) why.push('Death Cross (EMA20/50)!');
    }
    return { score: clamp(s), detail: why.join(', ') };
  }

  function macdAnalysis(x, i) {
    const { line, signal, hist } = x.macd;
    if (hist[i] === null || hist[i - 1] === null) return null;
    let s = hist[i] > 0 ? 0.5 : -0.5;
    let why = hist[i] > 0 ? 'MACD über Signallinie' : 'MACD unter Signallinie';
    if (hist[i - 1] <= 0 && hist[i] > 0) { s = 1; why = 'Bullisches MACD-Crossover'; }
    else if (hist[i - 1] >= 0 && hist[i] < 0) { s = -1; why = 'Bärisches MACD-Crossover'; }
    else if (Math.abs(hist[i]) > Math.abs(hist[i - 1])) { s *= 1.4; why += ', Momentum steigt'; }
    else { s *= 0.6; why += ', Momentum lässt nach'; }
    if (line[i] > 0 && signal[i] > 0) s += 0.1; else if (line[i] < 0 && signal[i] < 0) s -= 0.1;
    return { score: clamp(s), detail: `${why} (Hist ${fmt(hist[i], x.digits + 1)})` };
  }

  function rsiAnalysis(x, i) {
    const r = x.rsi[i], rp = x.rsi[i - 1];
    if (r === null || rp === null) return null;
    let s, why;
    if (r < 30) { s = 0.6 + (30 - r) / 50; why = 'überverkauft'; }
    else if (r > 70) { s = -0.6 - (r - 70) / 50; why = 'überkauft'; }
    else { s = (r - 50) / 40; why = r >= 50 ? 'bullische Zone' : 'bärische Zone'; }
    if (rp < 30 && r >= 30) { s = 1; why = 'verlässt überverkauften Bereich'; }
    if (rp > 70 && r <= 70) { s = -1; why = 'verlässt überkauften Bereich'; }
    return { score: clamp(s), detail: `RSI ${r.toFixed(1)} – ${why}` };
  }

  function stochAnalysis(x, i) {
    const k = x.stoch.k[i], d = x.stoch.d[i], kp = x.stoch.k[i - 1], dp = x.stoch.d[i - 1];
    if (k === null || d === null || kp === null || dp === null) return null;
    let s = k > d ? 0.3 : -0.3;
    let why = k > d ? '%K über %D' : '%K unter %D';
    if (k < 20) { s += 0.4; why += ', überverkauft'; }
    if (k > 80) { s -= 0.4; why += ', überkauft'; }
    if (kp <= dp && k > d && k < 30) { s = 1; why = 'Bullisches Crossover im überverkauften Bereich'; }
    if (kp >= dp && k < d && k > 70) { s = -1; why = 'Bärisches Crossover im überkauften Bereich'; }
    return { score: clamp(s), detail: `%K ${k.toFixed(1)} / %D ${d.toFixed(1)} – ${why}` };
  }

  function bollingerAnalysis(x, i) {
    const pb = x.bb.percentB[i];
    if (pb === null) return null;
    // Mean Reversion: nahe unterem Band = Kaufchance, nahe oberem = Verkauf.
    let s = clamp((0.5 - pb) * 1.6);
    let why = pb < 0 ? 'Kurs unter unterem Band' : pb > 1 ? 'Kurs über oberem Band' : `%B ${(pb * 100).toFixed(0)} %`;
    // Squeeze: sehr enge Bänder -> Ausbruch in Richtung des Kurses relativ zur Mitte.
    const bw = x.bb.bandwidth;
    let minBw = Infinity;
    for (let j = Math.max(0, i - 100); j <= i; j++) if (bw[j] !== null) minBw = Math.min(minBw, bw[j]);
    if (bw[i] !== null && bw[i] <= minBw * 1.1) {
      s = x.c[i] > x.bb.mid[i] ? 0.5 : -0.5;
      why += ', Squeeze → Ausbruch erwartet';
    }
    return { score: s, detail: why };
  }

  function adxAnalysis(x, i) {
    const a = x.adx.adx[i], p = x.adx.plusDI[i], m = x.adx.minusDI[i];
    if (a === null || p === null || m === null) return null;
    const dir = p > m ? 1 : -1;
    const strength = clamp((a - 15) / 25, 0, 1);
    const trend = a < 20 ? 'kein klarer Trend' : a < 25 ? 'schwacher Trend' : a < 40 ? 'starker Trend' : 'sehr starker Trend';
    return {
      score: dir * strength,
      detail: `ADX ${a.toFixed(1)} (${trend}), +DI ${p.toFixed(1)} ${p > m ? '>' : '<'} −DI ${m.toFixed(1)}`,
    };
  }

  function srAnalysis(x, i) {
    const a = x.atr[i];
    if (a === null) return null;
    const span = 3;
    // Nur Pivots nutzen, die zum Zeitpunkt i bereits bestätigt waren (kein Lookahead).
    const res = x.pivots.highs.filter((j) => j + span <= i && j >= i - 150).map((j) => x.h[j]);
    const sup = x.pivots.lows.filter((j) => j + span <= i && j >= i - 150).map((j) => x.l[j]);
    const p = x.c[i];
    const above = res.filter((v) => v > p);
    const below = sup.filter((v) => v < p);
    const nr = above.length ? Math.min(...above) : null;
    const ns = below.length ? Math.max(...below) : null;
    let s = 0;
    const why = [];
    if (ns !== null) {
      const d = (p - ns) / a;
      if (d < 1) s += 0.6 * (1 - d);
      why.push(`Support ${fmt(ns, x.digits)} (${d.toFixed(1)} ATR)`);
    }
    if (nr !== null) {
      const d = (nr - p) / a;
      if (d < 1) s -= 0.6 * (1 - d);
      why.push(`Widerstand ${fmt(nr, x.digits)} (${d.toFixed(1)} ATR)`);
    }
    // Ausbruch über letzten Widerstand / unter letzten Support.
    const lastRes = res.length ? res[res.length - 1] : null;
    const lastSup = sup.length ? sup[sup.length - 1] : null;
    if (lastRes !== null && x.c[i - 1] <= lastRes && p > lastRes) { s = 0.9; why.unshift('Ausbruch über Widerstand'); }
    if (lastSup !== null && x.c[i - 1] >= lastSup && p < lastSup) { s = -0.9; why.unshift('Bruch unter Support'); }
    return { score: clamp(s), detail: why.join(', ') || 'keine Level in der Nähe', support: ns, resistance: nr };
  }

  function momentumAnalysis(x, i) {
    const r = x.roc[i], a = x.atr[i];
    if (r === null || a === null) return null;
    // ROC normiert auf die typische Schwankung (ATR in %).
    const atrPct = (a / x.c[i]) * 100;
    const s = clamp(r / (atrPct * 3));
    return { score: s, detail: `ROC(10) ${r >= 0 ? '+' : ''}${r.toFixed(3)} %` };
  }

  function candleAnalysis(x, i) {
    const o = x.o[i], h = x.h[i], l = x.l[i], c = x.c[i];
    const po = x.o[i - 1], pc = x.c[i - 1];
    const body = Math.abs(c - o);
    const range = h - l || 1e-12;
    const upper = h - Math.max(o, c);
    const lower = Math.min(o, c) - l;
    const downtrend = x.ema20[i] !== null && c < x.ema20[i];
    const uptrend = x.ema20[i] !== null && c > x.ema20[i];
    if (pc < po && c > o && c >= po && o <= pc && body > Math.abs(pc - po)) return { score: 0.9, detail: 'Bullish Engulfing' };
    if (pc > po && c < o && c <= po && o >= pc && body > Math.abs(pc - po)) return { score: -0.9, detail: 'Bearish Engulfing' };
    if (lower > 2 * body && upper < body && downtrend) return { score: 0.7, detail: 'Hammer im Abwärtstrend' };
    if (upper > 2 * body && lower < body && uptrend) return { score: -0.7, detail: 'Shooting Star im Aufwärtstrend' };
    if (body / range < 0.1) return { score: 0, detail: 'Doji – Unentschlossenheit' };
    return { score: clamp(((c - o) / range) * 0.4), detail: c >= o ? 'bullische Kerze' : 'bärische Kerze' };
  }

  const ANALYSES = [
    ['trend', 'Trend (EMA 20/50/200)', trendAnalysis],
    ['macd', 'MACD (12/26/9)', macdAnalysis],
    ['adx', 'ADX / DMI (14)', adxAnalysis],
    ['rsi', 'RSI (14)', rsiAnalysis],
    ['stoch', 'Stochastik (14/3/3)', stochAnalysis],
    ['bollinger', 'Bollinger-Bänder (20/2)', bollingerAnalysis],
    ['sr', 'Support / Widerstand', srAnalysis],
    ['momentum', 'Momentum (ROC)', momentumAnalysis],
    ['candle', 'Kerzenmuster', candleAnalysis],
  ];

  function labelFor(score) {
    if (score >= 45) return 'STRONG BUY';
    if (score >= 15) return 'BUY';
    if (score <= -45) return 'STRONG SELL';
    if (score <= -15) return 'SELL';
    return 'NEUTRAL';
  }

  function evaluate(x, i) {
    if (i < MIN_BARS) return null;
    const results = [];
    let wsum = 0, total = 0;
    for (const [key, name, fn] of ANALYSES) {
      const r = fn(x, i);
      if (!r) continue;
      const w = WEIGHTS[key];
      results.push({ key, name, weight: w, ...r });
      wsum += w;
      total += w * r.score;
    }
    if (!wsum) return null;
    const score = (total / wsum) * 100;
    const dir = Math.sign(score);
    // Konfidenz: Anteil des Gewichts, das in die gleiche Richtung zeigt.
    const agree = results.reduce((acc, r) => acc + (Math.sign(r.score) === dir && Math.abs(r.score) > 0.1 ? r.weight : 0), 0);
    const confidence = dir === 0 ? 0 : (agree / wsum) * 100;
    const label = labelFor(score);

    const price = x.c[i];
    const a = x.atr[i];
    let levels = null;
    if (a !== null && label !== 'NEUTRAL') {
      const s = dir > 0 ? 1 : -1;
      levels = {
        entry: price,
        stopLoss: price - s * 1.5 * a,
        takeProfit1: price + s * 1.5 * a,
        takeProfit2: price + s * 3 * a,
        riskReward: 2,
      };
    }
    return { index: i, time: x.candles[i].time, price, score, label, confidence, atr: a, results, levels };
  }

  // Signalwechsel über die Historie – für Marker im Chart und die Trefferquote.
  function history(x) {
    const signals = [];
    let lastDir = 0;
    for (let i = MIN_BARS; i < x.c.length; i++) {
      const e = evaluate(x, i);
      if (!e) continue;
      const dir = e.label.includes('BUY') ? 1 : e.label.includes('SELL') ? -1 : 0;
      if (dir !== 0 && dir !== lastDir) signals.push({ index: i, time: e.time, dir, label: e.label, price: e.price });
      if (dir !== 0) lastDir = dir;
    }
    return signals;
  }

  // Einfacher Backtest: Signal gilt als Treffer, wenn der Kurs nach `horizon`
  // Bars in Signalrichtung liegt.
  function hitRate(x, signals, horizon = 10) {
    let hits = 0, n = 0;
    for (const s of signals) {
      const j = s.index + horizon;
      if (j >= x.c.length) continue;
      n++;
      if ((x.c[j] - s.price) * s.dir > 0) hits++;
    }
    return { hits, total: n, rate: n ? (hits / n) * 100 : null, horizon };
  }

  function analyze(candles, digits = 5) {
    const x = prepare(candles, digits);
    const current = evaluate(x, candles.length - 1);
    const signals = history(x);
    return { x, current, signals, backtest: hitRate(x, signals) };
  }

  // Nur das aktuelle Signal (ohne Historie) – schnell genug für Watchlist-Scans.
  function quick(candles, digits = 5) {
    return evaluate(prepare(candles, digits), candles.length - 1);
  }

  const Signal = { analyze, quick, prepare, evaluate, history, hitRate, labelFor, WEIGHTS, MIN_BARS };

  if (typeof module !== 'undefined' && module.exports) module.exports = Signal;
  else root.Signal = Signal;
})(typeof self !== 'undefined' ? self : this);
