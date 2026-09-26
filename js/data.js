/*
 * Kursdaten laden. Reihenfolge der Quellen:
 *   1. Binance EURUSDT-Kerzen (echte OHLC-Daten, alle Timeframes, kein API-Key)
 *   2. Frankfurter / EZB-Referenzkurse (nur Tageskurse)
 *   3. Simulierte Demo-Daten (offline)
 */
(function (root) {
  'use strict';

  const INTERVALS = { '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

  async function fetchJson(url, timeoutMs = 8000) {
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

  async function fromBinance(interval, limit) {
    const url = `https://api.binance.com/api/v3/klines?symbol=EURUSDT&interval=${interval}&limit=${limit}`;
    const rows = await fetchJson(url);
    if (!Array.isArray(rows) || rows.length < 100) throw new Error('zu wenige Daten');
    return rows.map((r) => ({
      time: Math.floor(r[0] / 1000),
      open: +r[1],
      high: +r[2],
      low: +r[3],
      close: +r[4],
    }));
  }

  async function fromFrankfurter() {
    const start = new Date(Date.now() - 800 * 86400e3).toISOString().slice(0, 10);
    const data = await fetchJson(`https://api.frankfurter.app/${start}..?from=EUR&to=USD`);
    const days = Object.keys(data.rates).sort();
    const out = [];
    let prev = null;
    for (const d of days) {
      const close = data.rates[d].USD;
      const open = prev ?? close;
      out.push({
        time: Math.floor(Date.parse(d + 'T00:00:00Z') / 1000),
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
      });
      prev = close;
    }
    if (out.length < 100) throw new Error('zu wenige Daten');
    return out;
  }

  function demo(interval, limit) {
    const step = INTERVALS[interval];
    const now = Math.floor(Date.now() / 1000 / step) * step;
    // Deterministischer Zufall, damit die Demo stabil bleibt.
    let seed = 42;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
    const vol = 0.0009 * Math.sqrt(step / 3600);
    let price = 1.1;
    let drift = 0;
    const out = [];
    for (let i = limit - 1; i >= 0; i--) {
      if (i % 80 === 0) drift = (rnd() - 0.5) * vol * 0.6;
      const open = price;
      const close = open * (1 + drift + gauss() * vol);
      const high = Math.max(open, close) * (1 + Math.abs(gauss()) * vol * 0.4);
      const low = Math.min(open, close) * (1 - Math.abs(gauss()) * vol * 0.4);
      out.push({ time: now - i * step, open, high, low, close });
      price = close;
    }
    return out;
  }

  // USD/EUR ist der Kehrwert von EUR/USD; Hoch und Tief tauschen dabei die Rollen.
  function invert(candles) {
    return candles.map((c) => ({
      time: c.time,
      open: 1 / c.open,
      high: 1 / c.low,
      low: 1 / c.high,
      close: 1 / c.close,
    }));
  }

  async function load({ pair = 'EURUSD', interval = '1h', limit = 500 } = {}) {
    let candles, source;
    try {
      candles = await fromBinance(interval, limit);
      source = 'Binance EUR/USDT (live)';
    } catch (e1) {
      try {
        candles = await fromFrankfurter();
        source = 'EZB-Referenzkurse via Frankfurter (nur Tageskerzen)';
        interval = '1d';
      } catch (e2) {
        candles = demo(interval, limit);
        source = 'Demo-Daten (offline – keine Live-Quelle erreichbar)';
      }
    }
    if (pair === 'USDEUR') candles = invert(candles);
    return { candles, source, interval };
  }

  const Data = { load, invert, demo, INTERVALS };

  if (typeof module !== 'undefined' && module.exports) module.exports = Data;
  else root.ForexData = Data;
})(typeof self !== 'undefined' ? self : this);
