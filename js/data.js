/*
 * Kursdaten für beliebige Währungspaare.
 *
 * Quellen (Modus "auto" probiert sie der Reihe nach):
 *   1. Twelve Data   – echte Forex-Kurse, alle Paare und Timeframes (kostenloser API-Key nötig)
 *   2. Binance       – USDT-Märkte als USD-Ersatz, Kreuzkurse werden aus zwei Legs berechnet
 *   3. EZB           – offizielle Referenzkurse via Frankfurter, nur Tages-/Wochenkerzen
 *   4. Demo          – deterministisch simulierte Kurse (offline)
 *
 * Intern wird jede Währung als "Leg" in USD bewertet (USD pro Einheit). Ein Paar A/B
 * ist dann Leg(A) / Leg(B). USD selbst hat kein Leg (null = konstant 1).
 */
(function (root) {
  'use strict';

  const C = typeof module !== 'undefined' && module.exports ? require('./currencies.js') : root.Currencies;

  const INTERVALS = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
  const TD_INTERVAL = { '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week' };

  const config = { provider: 'auto', tdKey: '' };
  const health = {}; // provider -> { ok: bool, at: ms, msg }

  function configure(opts) {
    Object.assign(config, opts);
  }

  // ---------------------------------------------------------------- Hilfen

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cache = new Map();

  // Ergebnis für `ttl` ms merken; parallele Anfragen teilen sich ein Promise.
  function cached(key, ttl, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.promise;
    const promise = fn();
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));
    return promise;
  }

  async function fetchJson(url, timeoutMs = 9000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  function mark(provider, ok, msg) {
    health[provider] = { ok, at: Date.now(), msg: msg || '' };
  }

  function invert(candles) {
    return candles.map((c) => ({ time: c.time, open: 1 / c.open, high: 1 / c.low, low: 1 / c.high, close: 1 / c.close }));
  }

  // Paar aus zwei USD-Legs bilden. Hoch/Tief sind bei Kreuzkursen eine Näherung,
  // weil die Extremwerte beider Legs nicht zur selben Zeit auftreten müssen.
  function combine(a, b) {
    if (!b) return a;
    if (!a) return invert(b);
    const byTime = new Map(b.map((c) => [c.time, c]));
    const out = [];
    for (const x of a) {
      const y = byTime.get(x.time);
      if (!y) continue;
      const open = x.open / y.open;
      const close = x.close / y.close;
      out.push({
        time: x.time,
        open,
        close,
        high: Math.max(open, close, x.high / y.close, x.close / y.low),
        low: Math.min(open, close, x.low / y.close, x.close / y.high),
      });
    }
    return out;
  }

  function aggregateWeekly(daily) {
    const out = [];
    for (const d of daily) {
      const day = new Date(d.time * 1000).getUTCDay();
      const monday = d.time - ((day + 6) % 7) * 86400;
      const last = out[out.length - 1];
      if (last && last.time === monday) {
        last.high = Math.max(last.high, d.high);
        last.low = Math.min(last.low, d.low);
        last.close = d.close;
      } else {
        out.push({ time: monday, open: d.open, high: d.high, low: d.low, close: d.close });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- Twelve Data

  // Kostenloser Plan: 8 Anfragen pro Minute -> Anfragen hintereinander einreihen.
  let tdNext = 0;
  async function tdSlot() {
    const now = Date.now();
    const at = Math.max(now, tdNext);
    tdNext = at + 7600;
    if (at > now) await sleep(at - now);
  }

  function fromTwelveData(pair, interval, limit) {
    if (!config.tdKey) return Promise.reject(new Error('kein API-Key'));
    const [a, b] = C.split(pair);
    return cached(`td:${pair}:${interval}`, interval === '5m' ? 60e3 : 120e3, async () => {
      await tdSlot();
      const url =
        `https://api.twelvedata.com/time_series?symbol=${a}/${b}&interval=${TD_INTERVAL[interval]}` +
        `&outputsize=${limit}&timezone=UTC&apikey=${encodeURIComponent(config.tdKey)}`;
      const j = await fetchJson(url);
      if (j.status === 'error' || !Array.isArray(j.values)) throw new Error(j.message || 'keine Daten');
      const candles = j.values
        .map((v) => {
          const iso = v.datetime.length > 10 ? v.datetime.replace(' ', 'T') + 'Z' : v.datetime + 'T00:00:00Z';
          return { time: Math.floor(Date.parse(iso) / 1000), open: +v.open, high: +v.high, low: +v.low, close: +v.close };
        })
        .reverse();
      if (candles.length < 80) throw new Error('zu wenige Kerzen');
      return candles;
    });
  }

  // ---------------------------------------------------------------- Binance

  function binanceSymbols() {
    return cached('bn:symbols', 6 * 3600e3, async () => {
      const rows = await fetchJson('https://api.binance.com/api/v3/ticker/price');
      return new Set(rows.map((r) => r.symbol));
    });
  }

  async function binanceLeg(ccy, interval, limit) {
    if (ccy === 'USD') return null;
    const symbols = await binanceSymbols();
    let symbol, inverse;
    if (symbols.has(ccy + 'USDT')) { symbol = ccy + 'USDT'; inverse = false; }
    else if (symbols.has('USDT' + ccy)) { symbol = 'USDT' + ccy; inverse = true; }
    else throw new Error(`${ccy} nicht auf Binance`);
    return cached(`bn:${symbol}:${interval}`, 45e3, async () => {
      const rows = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      const candles = rows.map((r) => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4] }));
      const step = INTERVALS[interval];
      if (candles.length < 80) throw new Error(`${symbol}: zu wenige Kerzen`);
      if (Date.now() / 1000 - candles[candles.length - 1].time > step * 3) throw new Error(`${symbol}: keine aktuellen Kurse`);
      return inverse ? invert(candles) : candles;
    });
  }

  async function fromBinance(pair, interval, limit) {
    const [a, b] = C.split(pair);
    const [la, lb] = await Promise.all([binanceLeg(a, interval, limit), binanceLeg(b, interval, limit)]);
    const candles = combine(la, lb);
    if (candles.length < 80) throw new Error('zu wenige gemeinsame Kerzen');
    return candles;
  }

  // ---------------------------------------------------------------- EZB (Frankfurter)

  // Eine Anfrage liefert alle Währungen gegen USD – daraus lassen sich alle Paare bilden.
  function ecbTable() {
    return cached('ecb', 30 * 60e3, async () => {
      const start = new Date(Date.now() - 520 * 86400e3).toISOString().slice(0, 10);
      let data;
      try {
        data = await fetchJson(`https://api.frankfurter.dev/v1/${start}..?base=USD`);
      } catch (e) {
        data = await fetchJson(`https://api.frankfurter.app/${start}..?from=USD`);
      }
      const dates = Object.keys(data.rates).sort();
      if (dates.length < 100) throw new Error('zu wenige Tage');
      return { dates, rates: data.rates };
    });
  }

  function ecbLeg(table, ccy) {
    if (ccy === 'USD') return null;
    const out = [];
    let prev = null;
    for (const d of table.dates) {
      const r = table.rates[d][ccy];
      if (!r) continue;
      const close = 1 / r;
      const open = prev ?? close;
      out.push({
        time: Math.floor(Date.parse(d + 'T00:00:00Z') / 1000),
        open,
        close,
        high: Math.max(open, close),
        low: Math.min(open, close),
      });
      prev = close;
    }
    if (!out.length) throw new Error(`${ccy} nicht bei der EZB`);
    return out;
  }

  async function fromEcb(pair, interval) {
    const table = await ecbTable();
    const [a, b] = C.split(pair);
    const daily = combine(ecbLeg(table, a), ecbLeg(table, b));
    return interval === '1w' ? aggregateWeekly(daily) : daily;
  }

  // ---------------------------------------------------------------- Demo

  // Deterministischer Zufall aus (Währung, Zahl): gleiche Zeit -> gleicher Kurs,
  // damit Demo-Kurse über Refreshes und Timeframes hinweg zusammenpassen.
  function hash(str, n) {
    let h = 2166136261 ^ n;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  const gauss = (s, n) => Math.sqrt(-2 * Math.log(hash(s, n) || 1e-9)) * Math.cos(2 * Math.PI * hash(s + '#', n));

  const OCTAVES = [60, 900, 3600, 14400, 86400, 345600, 1382400, 5529600];
  const T_REF = 1767225600; // 2026-01-01

  function demoVol(ccy) {
    if (ccy === 'TRY' || ccy === 'ZAR' || ccy === 'BRL' || ccy === 'MXN') return 2.2;
    if (ccy === 'HKD' || ccy === 'BGN' || ccy === 'DKK') return 0.25; // gekoppelte Währungen
    if (C.MAJOR_CCY.includes(ccy)) return 1;
    return 1.4;
  }

  // Log-Kurs einer Währung in USD zum Zeitpunkt t (Sekunden).
  function demoLogPrice(ccy, t) {
    const volPerSqrtSec = 0.0045 / Math.sqrt(86400) * demoVol(ccy);
    let v = Math.log(C.USD_VALUE[ccy]);
    for (const r of OCTAVES) {
      const k = Math.floor(t / r);
      const f = t / r - k;
      const s = f * f * (3 - 2 * f);
      const g = gauss(ccy + r, k) * (1 - s) + gauss(ccy + r, k + 1) * s;
      v += g * volPerSqrtSec * Math.sqrt(r) * 0.55;
    }
    if (ccy === 'TRY') v -= 0.25 * (t - T_REF) / 31536000; // Lira wertet langfristig ab
    return v;
  }

  function demoLeg(ccy, interval, limit) {
    if (ccy === 'USD') return null;
    const step = INTERVALS[interval];
    const now = Math.floor(Date.now() / 1000);
    const lastOpen = Math.floor(now / step) * step;
    const out = [];
    for (let i = limit - 1; i >= 0; i--) {
      const t0 = lastOpen - i * step;
      const t1 = Math.min(t0 + step, now);
      const open = Math.exp(demoLogPrice(ccy, t0));
      const close = Math.exp(demoLogPrice(ccy, t1));
      let high = Math.max(open, close);
      let low = Math.min(open, close);
      for (let j = 1; j < 8; j++) {
        const p = Math.exp(demoLogPrice(ccy, t0 + ((t1 - t0) * j) / 8));
        high = Math.max(high, p);
        low = Math.min(low, p);
      }
      out.push({ time: t0, open, high, low, close });
    }
    return out;
  }

  function fromDemo(pair, interval, limit) {
    const [a, b] = C.split(pair);
    return combine(demoLeg(a, interval, limit), demoLeg(b, interval, limit));
  }

  // ---------------------------------------------------------------- Auswahl

  const PROVIDERS = {
    twelvedata: { name: 'Twelve Data', kind: 'live', fn: (p, i, l) => fromTwelveData(p, i, l) },
    binance: { name: 'Binance (USDT)', kind: 'live', fn: (p, i, l) => fromBinance(p, i, l) },
    ecb: { name: 'EZB-Referenzkurs', kind: 'daily', fn: (p, i) => fromEcb(p, i === '1w' ? '1w' : '1d') },
    demo: { name: 'Demo', kind: 'demo', fn: (p, i, l) => Promise.resolve(fromDemo(p, i, l)) },
  };

  function chain() {
    switch (config.provider) {
      case 'twelvedata': return ['twelvedata', 'demo'];
      case 'binance': return ['binance', 'demo'];
      case 'ecb': return ['ecb', 'demo'];
      case 'demo': return ['demo'];
      default: return [...(config.tdKey ? ['twelvedata'] : []), 'binance', 'ecb', 'demo'];
    }
  }

  // Liefert { candles, provider, source, kind, interval, note }.
  async function getCandles(pair, interval = '1h', { limit = 500 } = {}) {
    const errors = [];
    for (const id of chain()) {
      const p = PROVIDERS[id];
      try {
        const candles = await p.fn(pair, interval, limit);
        if (id !== 'demo') mark(id, true);
        const used = id === 'ecb' ? (interval === '1w' ? '1w' : '1d') : interval;
        const synthetic = id === 'binance' && !pair.includes('USD');
        return {
          candles,
          provider: id,
          source: p.name + (synthetic ? ' · Kreuzkurs' : ''),
          kind: p.kind,
          interval: used,
          note: used !== interval
            ? `Für ${C.label(pair)} gibt es ${config.tdKey ? '' : 'ohne API-Key '}keine ${interval}-Daten – angezeigt werden Tageskerzen der EZB.`
            : '',
          errors,
        };
      } catch (e) {
        if (id !== 'demo') mark(id, false, e.message);
        errors.push(`${p.name}: ${e.message}`);
      }
    }
    throw new Error(errors.join(' · '));
  }

  // Umrechnungskurs (1 `from` = x `to`) für den Positionsrechner. Nutzt geladene
  // Kurse (direkt oder über USD) und fällt nur ohne Daten auf Näherungswerte zurück.
  function rate(from, to, known = {}) {
    if (from === to) return 1;
    if (known[from + to]) return known[from + to];
    if (known[to + from]) return 1 / known[to + from];
    const usd = (c) => {
      if (c === 'USD') return 1;
      if (known[c + 'USD']) return known[c + 'USD'];
      if (known['USD' + c]) return 1 / known['USD' + c];
      return C.USD_VALUE[c];
    };
    return usd(from) / usd(to);
  }

  const Data = {
    INTERVALS, PROVIDERS, configure, config, health, getCandles, rate,
    invert, combine, aggregateWeekly, fromDemo, demoLeg,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Data;
  else root.ForexData = Data;
})(typeof self !== 'undefined' ? self : this);
