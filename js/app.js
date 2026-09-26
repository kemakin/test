(function () {
  'use strict';

  const LWC = window.LightweightCharts;
  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 60_000;

  const state = { pair: 'EURUSD', interval: '1h', fitNext: true, timer: null };

  const COLORS = {
    buy: '#22c38e', sell: '#ef5b5b', neutral: '#f5b841',
    ema20: '#f5b841', ema50: '#4c8dff', bb: 'rgba(138,147,166,.7)', text: '#8a93a6', grid: '#1e2632',
  };

  const baseOptions = {
    layout: { background: { color: 'transparent' }, textColor: COLORS.text, fontSize: 11 },
    grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
    rightPriceScale: { borderColor: '#263041', minimumWidth: 70 },
    timeScale: { borderColor: '#263041', timeVisible: true, secondsVisible: false },
    crosshair: { mode: LWC ? LWC.CrosshairMode.Normal : 0 },
    localization: { locale: 'en-US' },
    autoSize: true,
  };
  const priceFormat = { type: 'price', precision: 5, minMove: 0.00001 };

  let charts = null;

  function createCharts() {
    const main = LWC.createChart($('chart-main'), baseOptions);
    const candles = main.addCandlestickSeries({
      upColor: COLORS.buy, downColor: COLORS.sell, borderVisible: false,
      wickUpColor: COLORS.buy, wickDownColor: COLORS.sell, priceFormat,
    });
    const line = (color, width = 2, style = 0) =>
      main.addLineSeries({ color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat });
    const ema20 = line(COLORS.ema20);
    const ema50 = line(COLORS.ema50);
    const bbUp = line(COLORS.bb, 1, 2);
    const bbLow = line(COLORS.bb, 1, 2);

    const subOpts = {
      ...baseOptions,
      layout: { ...baseOptions.layout, attributionLogo: false },
      timeScale: { ...baseOptions.timeScale, visible: false },
    };
    const rsiChart = LWC.createChart($('chart-rsi'), subOpts);
    const rsi = rsiChart.addLineSeries({ color: '#b48cff', lineWidth: 2, priceLineVisible: false });
    rsi.createPriceLine({ price: 70, color: COLORS.sell, lineStyle: 2, lineWidth: 1, axisLabelVisible: false });
    rsi.createPriceLine({ price: 30, color: COLORS.buy, lineStyle: 2, lineWidth: 1, axisLabelVisible: false });

    const macdChart = LWC.createChart($('chart-macd'), subOpts);
    const macdFmt = { type: 'price', precision: 6, minMove: 0.000001 };
    const hist = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: macdFmt });
    const macdLine = macdChart.addLineSeries({ color: COLORS.ema50, lineWidth: 2, priceLineVisible: false, priceFormat: macdFmt });
    const macdSig = macdChart.addLineSeries({ color: COLORS.ema20, lineWidth: 1, priceLineVisible: false, priceFormat: macdFmt });

    // Zeitachsen der drei Charts synchron halten.
    const all = [main, rsiChart, macdChart];
    let syncing = false;
    for (const src of all) {
      src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        for (const dst of all) if (dst !== src) dst.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      });
    }

    return { main, candles, ema20, ema50, bbUp, bbLow, rsiChart, rsi, macdChart, hist, macdLine, macdSig, all };
  }

  const series = (candles, arr) =>
    arr.map((v, i) => (v === null ? { time: candles[i].time } : { time: candles[i].time, value: v }));

  function renderCharts(candles, result) {
    const { x, signals } = result;
    charts.candles.setData(candles);
    charts.ema20.setData(series(candles, x.ema20));
    charts.ema50.setData(series(candles, x.ema50));
    charts.bbUp.setData(series(candles, x.bb.upper));
    charts.bbLow.setData(series(candles, x.bb.lower));
    charts.rsi.setData(series(candles, x.rsi));
    charts.macdLine.setData(series(candles, x.macd.line));
    charts.macdSig.setData(series(candles, x.macd.signal));
    charts.hist.setData(
      x.macd.hist.map((v, i) =>
        v === null ? { time: candles[i].time } : { time: candles[i].time, value: v, color: v >= 0 ? 'rgba(34,195,142,.6)' : 'rgba(239,91,91,.6)' }
      )
    );
    charts.candles.setMarkers(
      signals.map((s) => ({
        time: s.time,
        position: s.dir > 0 ? 'belowBar' : 'aboveBar',
        color: s.dir > 0 ? COLORS.buy : COLORS.sell,
        shape: s.dir > 0 ? 'arrowUp' : 'arrowDown',
        text: s.dir > 0 ? 'BUY' : 'SELL',
      }))
    );

    // Stop-Loss / Take-Profit des aktuellen Signals als Linien einzeichnen.
    for (const pl of charts.levelLines || []) charts.candles.removePriceLine(pl);
    charts.levelLines = [];
    const lv = result.current && result.current.levels;
    if (lv) {
      const add = (price, color, title) =>
        charts.levelLines.push(charts.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title }));
      add(lv.stopLoss, COLORS.sell, 'SL');
      add(lv.takeProfit1, COLORS.buy, 'TP1');
      add(lv.takeProfit2, COLORS.buy, 'TP2');
    }

    if (state.fitNext) {
      const n = candles.length;
      charts.main.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 5 });
      state.fitNext = false;
    }
  }

  const tone = (label) => (label.includes('BUY') ? 'buy' : label.includes('SELL') ? 'sell' : 'neutral');
  const verdict = (s) => (s > 0.15 ? ['Bullisch', 'buy'] : s < -0.15 ? ['Bärisch', 'sell'] : ['Neutral', 'neutral']);
  const p5 = (v) => v.toFixed(5);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

  function fmtTime(t) {
    return new Date(t * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function renderSignal(candles, result) {
    const cur = result.current;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const chg = ((last.close - prev.close) / prev.close) * 100;
    $('price').textContent = p5(last.close);
    $('change').textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(3)} %`;
    $('change').className = 'change ' + (chg >= 0 ? 'up' : 'down');

    const card = $('signal-card');
    if (!cur) {
      card.className = 'card signal neutral';
      $('signal-label').textContent = 'ZU WENIG DATEN';
      return;
    }
    card.className = 'card signal ' + tone(cur.label);
    $('signal-label').textContent = cur.label;
    $('gauge-needle').style.left = `${50 + cur.score / 2}%`;
    $('score').textContent = `${cur.score >= 0 ? '+' : ''}${cur.score.toFixed(1)}`;
    $('confidence').textContent = `${cur.confidence.toFixed(0)} %`;
    $('atr').textContent = cur.atr !== null ? `${(cur.atr * 1e4).toFixed(1)} Pips` : '–';
    $('updated').textContent = new Date().toLocaleTimeString('de-DE');

    const lv = cur.levels;
    $('levels').innerHTML = lv
      ? `<div><span>Entry</span><b>${p5(lv.entry)}</b></div>
         <div class="sl"><span>Stop-Loss</span><b>${p5(lv.stopLoss)}</b></div>
         <div class="tp"><span>Take-Profit 1</span><b>${p5(lv.takeProfit1)}</b></div>
         <div class="tp"><span>Take-Profit 2</span><b>${p5(lv.takeProfit2)}</b></div>
         <p>SL = 1,5 × ATR · TP2 mit Chance/Risiko 1 : ${lv.riskReward}</p>`
      : '<p>Kein klares Setup – abwarten, bis sich die Analysen einig sind.</p>';

    $('analyses').innerHTML = cur.results
      .map((r) => {
        const [text, cls] = verdict(r.score);
        const w = Math.abs(r.score) * 50;
        const left = r.score >= 0 ? 50 : 50 - w;
        const color = r.score >= 0 ? 'var(--buy)' : 'var(--sell)';
        return `<li>
          <span class="name">${esc(r.name)} <span class="muted">×${r.weight}</span></span>
          <span class="verdict ${cls}">${text}</span>
          <div class="bar"><span style="left:${left}%;width:${w}%;background:${color}"></span></div>
          <span class="detail">${esc(r.detail)}</span>
        </li>`;
      })
      .join('');

    const bt = result.backtest;
    $('backtest').innerHTML = bt.rate === null
      ? 'Noch keine auswertbaren Signale.'
      : `<b>${bt.rate.toFixed(0)} %</b> Trefferquote bei ${bt.total} Signalwechseln
         (Kurs ${bt.horizon} Kerzen später in Signalrichtung).`;
    $('recent').innerHTML = result.signals
      .slice(-6)
      .reverse()
      .map((s) => `<li><span class="${s.dir > 0 ? 'b' : 's'}">${s.label}</span><span>${p5(s.price)}</span><span class="muted">${fmtTime(s.time)}</span></li>`)
      .join('');
  }

  async function run() {
    const btn = $('refresh');
    btn.disabled = true;
    try {
      const { candles, source, interval } = await window.ForexData.load({ pair: state.pair, interval: state.interval });
      if (interval !== state.interval) {
        state.interval = interval;
        highlightInterval();
      }
      const result = window.Signal.analyze(candles);
      const pairName = state.pair === 'EURUSD' ? 'EUR/USD' : 'USD/EUR';
      $('source').textContent = `${pairName} · ${state.interval.toUpperCase()} · Quelle: ${source}`;
      document.title = `${result.current ? result.current.label : ''} ${pairName} – Forex Signal AI`;
      renderCharts(candles, result);
      renderSignal(candles, result);
    } catch (err) {
      console.error(err);
      $('source').textContent = 'Fehler beim Laden: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  function highlightInterval() {
    for (const b of $('intervals').querySelectorAll('button')) b.classList.toggle('active', b.dataset.i === state.interval);
  }

  function schedule() {
    clearInterval(state.timer);
    state.timer = setInterval(run, REFRESH_MS);
  }

  function init() {
    if (!LWC) {
      $('source').textContent = 'Chart-Bibliothek konnte nicht geladen werden (Internetverbindung prüfen).';
      return;
    }
    charts = createCharts();
    $('pair').addEventListener('change', (e) => { state.pair = e.target.value; state.fitNext = true; run(); });
    $('intervals').addEventListener('click', (e) => {
      const i = e.target.dataset && e.target.dataset.i;
      if (!i) return;
      state.interval = i;
      state.fitNext = true;
      highlightInterval();
      run();
    });
    $('refresh').addEventListener('click', run);
    run();
    schedule();
  }

  init();
})();
