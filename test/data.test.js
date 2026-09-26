const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/currencies.js');
const D = require('../js/data.js');

const near = (a, b, rel = 1e-9) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel, `${a} != ${b}`);

test('Pip-Größe und Nachkommastellen', () => {
  assert.strictEqual(C.pipSize('EURUSD', 1.09), 0.0001);
  assert.strictEqual(C.pipSize('USDJPY', 150), 0.01);
  assert.strictEqual(C.pipSize('USDHUF', 360), 0.01);
  assert.strictEqual(C.pipSize('USDIDR', 16000), 1);
  assert.strictEqual(C.digits('EURUSD', 1.09), 5);
  assert.strictEqual(C.digits('USDJPY', 150), 3);
  assert.strictEqual(C.category('EURUSD'), 'major');
  assert.strictEqual(C.category('GBPJPY'), 'minor');
  assert.strictEqual(C.category('USDTRY'), 'exotic');
});

test('alle Paare bestehen aus bekannten Währungen', () => {
  for (const p of C.allPairs()) {
    const [a, b] = C.split(p);
    assert.ok(C.CURRENCIES[a] && C.CURRENCIES[b] && a !== b, p);
  }
  assert.strictEqual(new Set(C.allPairs()).size, C.allPairs().length);
});

test('Kreuzkurs aus zwei USD-Legs', () => {
  const eur = [{ time: 1, open: 1.1, high: 1.12, low: 1.09, close: 1.11 }];
  const jpy = [{ time: 1, open: 1 / 150, high: 1 / 149, low: 1 / 151, close: 1 / 148 }];
  const [c] = D.combine(eur, jpy);
  near(c.open, 1.1 * 150);
  near(c.close, 1.11 * 148);
  assert.ok(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));
  // USD als Kurswährung (Leg = null) lässt die Kerze unverändert
  assert.deepStrictEqual(D.combine(eur, null), eur);
  // USD als Basiswährung invertiert
  near(D.combine(null, eur)[0].close, 1 / 1.11);
});

test('Demo-Kreuzkurse passen zu den Majors (EURJPY = EURUSD × USDJPY)', () => {
  const eurusd = D.fromDemo('EURUSD', '1h', 50);
  const usdjpy = D.fromDemo('USDJPY', '1h', 50);
  const eurjpy = D.fromDemo('EURJPY', '1h', 50);
  for (let i = 0; i < 50; i++) near(eurjpy[i].close, eurusd[i].close * usdjpy[i].close, 1e-9);
});

test('Demo-Daten sind stabil über Aufrufe hinweg', () => {
  const a = D.fromDemo('GBPUSD', '4h', 100);
  const b = D.fromDemo('GBPUSD', '4h', 100);
  assert.deepStrictEqual(a.slice(0, -1), b.slice(0, -1));
});

test('Wochenkerzen aus Tageskerzen', () => {
  const monday = Date.parse('2026-09-07T00:00:00Z') / 1000;
  const days = [0, 1, 2, 3, 4, 7, 8].map((d, i) => ({ time: monday + d * 86400, open: 1 + i, high: 2 + i, low: i, close: 1.5 + i }));
  const w = D.aggregateWeekly(days);
  assert.strictEqual(w.length, 2);
  assert.deepStrictEqual(w[0], { time: monday, open: 1, high: 6, low: 0, close: 5.5 });
});

test('Umrechnung über USD mit geladenen Kursen', () => {
  near(D.rate('TRY', 'EUR', { USDTRY: 40, EURUSD: 1.1 }), 1 / 40 / 1.1);
  near(D.rate('GBP', 'JPY', { GBPUSD: 1.3, USDJPY: 150 }), 195);
  near(D.rate('EUR', 'GBP', { EURGBP: 0.85 }), 0.85);
});

// ---- Datenquellen mit simuliertem fetch

function klines(n, price, step) {
  const now = Math.floor(Date.now() / 1000 / step) * step;
  return Array.from({ length: n }, (_, i) => {
    const t = (now - (n - 1 - i) * step) * 1000;
    const p = price * (1 + Math.sin(i / 5) * 0.002);
    return [t, String(p), String(p * 1.001), String(p * 0.999), String(p), '0'];
  });
}

function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    for (const [re, body] of routes) {
      if (re.test(url)) {
        const data = typeof body === 'function' ? body(url) : body;
        if (data instanceof Error) throw data;
        return { ok: true, status: 200, json: async () => data };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return calls;
}

test('Binance: Kreuzkurs EUR/TRY aus EURUSDT und USDTTRY', async () => {
  const calls = mockFetch([
    [/ticker\/price/, [{ symbol: 'EURUSDT' }, { symbol: 'USDTTRY' }]],
    [/symbol=EURUSDT/, klines(300, 1.1, 3600)],
    [/symbol=USDTTRY/, klines(300, 40, 3600)],
  ]);
  D.configure({ provider: 'binance', tdKey: '' });
  const r = await D.getCandles('EURTRY', '1h', { limit: 300 });
  assert.strictEqual(r.provider, 'binance');
  assert.strictEqual(r.kind, 'live');
  assert.match(r.source, /Kreuzkurs/);
  near(r.candles[0].close, 1.1 * 40, 0.01);
  assert.ok(calls.some((u) => u.includes('USDTTRY')));
});

test('Auto-Modus: ohne Binance-Markt → EZB-Tageskerzen mit Hinweis', async () => {
  const rates = {};
  const start = Date.now() - 300 * 86400e3;
  for (let i = 0; i < 300; i++) {
    const d = new Date(start + i * 86400e3).toISOString().slice(0, 10);
    rates[d] = { EUR: 0.9, CHF: 0.8 + i * 0.0001, JPY: 150 };
  }
  mockFetch([
    [/ticker\/price/, [{ symbol: 'EURUSDT' }]],
    [/frankfurter/, { base: 'USD', rates }],
  ]);
  D.configure({ provider: 'auto', tdKey: '' });
  const r = await D.getCandles('CHFJPY', '1h');
  assert.strictEqual(r.provider, 'ecb');
  assert.strictEqual(r.interval, '1d');
  assert.match(r.note, /Tageskerzen/);
  near(r.candles[r.candles.length - 1].close, 150 / (0.8 + 299 * 0.0001));
});

test('Twelve Data wird mit API-Key zuerst genutzt', async () => {
  const values = Array.from({ length: 200 }, (_, i) => ({
    datetime: new Date(Date.now() - i * 3600e3).toISOString().slice(0, 13).replace('T', ' ') + ':00:00',
    open: '1.1', high: '1.101', low: '1.099', close: String(1.1 + i * 1e-5),
  }));
  const calls = mockFetch([[/twelvedata/, { status: 'ok', values }]]);
  D.configure({ provider: 'auto', tdKey: 'abc' });
  const r = await D.getCandles('GBPCHF', '1h');
  assert.strictEqual(r.provider, 'twelvedata');
  assert.ok(calls[0].includes('symbol=GBP/CHF') && calls[0].includes('apikey=abc'));
  // Neueste Kerze steht am Ende
  assert.ok(r.candles[r.candles.length - 1].time > r.candles[0].time);
});

test('ohne erreichbare Quelle → Demo-Daten', async () => {
  mockFetch([[/./, new Error('offline')]]);
  D.configure({ provider: 'auto', tdKey: '' });
  const r = await D.getCandles('NZDCAD', '15m');
  assert.strictEqual(r.kind, 'demo');
  assert.strictEqual(r.candles.length, 500);
});
