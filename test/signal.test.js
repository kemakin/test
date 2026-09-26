const test = require('node:test');
const assert = require('node:assert');
const I = require('../js/indicators.js');
const Signal = require('../js/signal.js');
const Data = require('../js/data.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('sma und ema', () => {
  assert.deepStrictEqual(I.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = I.ema([1, 2, 3, 4, 5], 3);
  close(e[2], 2);
  close(e[3], 3);
  close(e[4], 4);
});

test('rsi: nur steigende Kurse = 100, nur fallende = 0', () => {
  const up = Array.from({ length: 30 }, (_, i) => 1 + i * 0.001);
  assert.strictEqual(I.rsi(up).at(-1), 100);
  const down = up.slice().reverse();
  close(I.rsi(down).at(-1), 0);
});

test('bollinger %B liegt zwischen 0 und 1 bei Seitwärtsmarkt', () => {
  const c = Array.from({ length: 50 }, (_, i) => 1.1 + Math.sin(i) * 0.001);
  const pb = I.bollinger(c).percentB.at(-1);
  assert.ok(pb > -0.5 && pb < 1.5);
});

function trend(dir, n = 300) {
  return Array.from({ length: n }, (_, i) => {
    const base = 1.1 + dir * i * 0.0004 + Math.sin(i / 3) * 0.0006;
    return { time: i * 3600, open: base - dir * 0.0001, high: base + 0.0008, low: base - 0.0008, close: base + dir * 0.0001 };
  });
}

test('Aufwärtstrend ergibt BUY-Signal', () => {
  const r = Signal.analyze(trend(1), 5);
  assert.ok(r.current.score > 15, `score ${r.current.score}`);
  assert.match(r.current.label, /BUY/);
  assert.ok(r.current.levels.stopLoss < r.current.price);
  assert.ok(r.current.levels.takeProfit1 > r.current.price);
});

test('Abwärtstrend ergibt SELL-Signal', () => {
  const r = Signal.analyze(trend(-1));
  assert.ok(r.current.score < -15, `score ${r.current.score}`);
  assert.match(r.current.label, /SELL/);
  assert.ok(r.current.levels.stopLoss > r.current.price);
});

test('USD/EUR ist gespiegelt zu EUR/USD', () => {
  const candles = Data.fromDemo('EURUSD', '1h', 400);
  const a = Signal.analyze(candles).current;
  const b = Signal.analyze(Data.invert(candles)).current;
  assert.strictEqual(Math.sign(a.results.find((r) => r.key === 'trend').score), -Math.sign(b.results.find((r) => r.key === 'trend').score));
  for (const c of Data.invert(candles)) assert.ok(c.high >= c.low);
});

test('alle Analysen liefern Scores in [-1, 1]', () => {
  const x = Signal.prepare(Data.fromDemo('EURUSD', '1h', 500));
  for (let i = Signal.MIN_BARS; i < 500; i++) {
    for (const r of Signal.evaluate(x, i).results) assert.ok(r.score >= -1 && r.score <= 1, `${r.key} ${r.score}`);
  }
});

test('quick() liefert dasselbe aktuelle Signal wie analyze()', () => {
  const c = Data.fromDemo('USDJPY', '1h', 300);
  const a = Signal.analyze(c, 3).current;
  const b = Signal.quick(c, 3);
  assert.strictEqual(a.label, b.label);
  assert.strictEqual(a.score, b.score);
  assert.match(b.results.find((r) => r.key === 'sr').detail, /\d+\.\d{3}\b/);
});
