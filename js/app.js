(function () {
  'use strict';

  const LWC = window.LightweightCharts;
  const C = window.Currencies;
  const S = window.Signal;
  const D = window.ForexData;
  const $ = (id) => document.getElementById(id);

  const TFS = ['5m', '15m', '1h', '4h', '1d', '1w'];
  const MTF = [['15m', 1], ['1h', 1.5], ['4h', 2], ['1d', 2], ['1w', 1.5]];
  const TF_LABEL = { '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' };
  const COLORS = {
    buy: '#1fc98e', sell: '#f25f5c', warn: '#f2b544', accent: '#5b8cff', muted: '#7c8a9b',
    ema20: '#f2b544', ema50: '#5b8cff', ema200: '#c77dff', bb: 'rgba(124,138,155,.75)',
    grid: '#141c25', border: '#1e2935',
  };

  // ------------------------------------------------------------------ Einstellungen

  const STORE_KEY = 'forex-signal-ai:v2';
  const DEFAULTS = {
    pair: 'EURUSD',
    interval: '1h',
    provider: 'auto',
    tdKey: '',
    refresh: 60,
    watchlist: C.DEFAULT_WATCHLIST.slice(),
    favorites: ['EURUSD', 'GBPJPY'],
    overlays: { ema20: true, ema50: true, ema200: false, bb: true, sr: true, markers: true, levels: true },
    chartType: 'candles',
    osc: 'rsi',
    acc: { ccy: 'EUR', balance: 10000, risk: 1 },
    wlFilter: 'all',
    wlSort: 'default',
  };

  const validPair = (p) =>
    typeof p === 'string' && /^[A-Z]{6}$/.test(p) && !!C.CURRENCIES[p.slice(0, 3)] && !!C.CURRENCIES[p.slice(3)] && p.slice(0, 3) !== p.slice(3);

  function loadConfig() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    const c = {
      ...DEFAULTS,
      ...saved,
      overlays: { ...DEFAULTS.overlays, ...(saved.overlays || {}) },
      acc: { ...DEFAULTS.acc, ...(saved.acc || {}) },
    };
    c.watchlist = [...new Set((Array.isArray(c.watchlist) ? c.watchlist : DEFAULTS.watchlist).filter(validPair))];
    c.favorites = [...new Set((Array.isArray(c.favorites) ? c.favorites : []).filter(validPair))];
    if (!validPair(c.pair)) c.pair = DEFAULTS.pair;
    if (!TFS.includes(c.interval)) c.interval = DEFAULTS.interval;
    if (!C.MAJOR_CCY.includes(c.acc.ccy)) c.acc.ccy = 'EUR';
    return c;
  }

  function saveConfig() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) { /* Speicher nicht verfügbar */ }
  }

  const cfg = loadConfig();
  D.configure({ provider: cfg.provider, tdKey: cfg.tdKey });

  // ------------------------------------------------------------------ Zustand

  const scan = new Map(); // pair -> Watchlist-Eintrag
  const alerts = [];
  let main = null; // aktuell im Chart angezeigtes Paar
  let mainSeq = 0;
  let scanning = false;
  let mtfState = { pair: null, at: 0, rows: {} };
  let slManual = false;
  let timer = null;
  let charts = null;

  // ------------------------------------------------------------------ Hilfen

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const dirOf = (label) => (!label ? 0 : label.includes('BUY') ? 1 : label.includes('SELL') ? -1 : 0);
  const tone = (label) => (dirOf(label) > 0 ? 'buy' : dirOf(label) < 0 ? 'sell' : 'neutral');
  const SHORT = { 'STRONG BUY': 'S.BUY', BUY: 'BUY', NEUTRAL: 'NEUTRAL', SELL: 'SELL', 'STRONG SELL': 'S.SELL' };
  const chip = (label) =>
    label
      ? `<span class="chip ${tone(label)}${label.startsWith('STRONG') ? ' strong' : ''}">${SHORT[label]}</span>`
      : '<span class="chip">…</span>';
  const fmtPrice = (pair, v) => (v === null || v === undefined || !isFinite(v) ? '–' : v.toFixed(C.digits(pair, v)));
  const fmtPct = (v) => (v === null || v === undefined || !isFinite(v) ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} %`);
  const signed = (v, d = 1) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`;
  const money = (v, ccy) => {
    try { return new Intl.NumberFormat('de-DE', { style: 'currency', currency: ccy, maximumFractionDigits: 2 }).format(v); }
    catch (e) { return `${v.toFixed(2)} ${ccy}`; }
  };

  function fmtTime(t, withDate = true) {
    const d = new Date(t * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return withDate ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${time}` : time;
  }

  // Veränderung gegenüber ~24 h (intraday) bzw. der Vorkerze (Tag/Woche).
  function changePct(candles, interval) {
    const last = candles[candles.length - 1];
    let ref = candles[candles.length - 2];
    if (D.INTERVALS[interval] < 86400) {
      const target = last.time - 86400;
      for (let i = candles.length - 1; i >= 0; i--) {
        if (candles[i].time <= target) { ref = candles[i]; break; }
      }
    }
    return ref ? ((last.close - ref.close) / ref.close) * 100 : null;
  }

  function sparkline(values, up) {
    if (values.length < 2) return '';
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 64).toFixed(1)},${(15 - ((v - min) / span) * 14).toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 64 16" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${up ? COLORS.buy : COLORS.sell}" stroke-width="1.3" stroke-linejoin="round"/></svg>`;
  }

  function toast(msg, cls = '') {
    const el = document.createElement('div');
    el.className = `toast ${cls}`;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  const usesTwelveData = () => cfg.provider === 'twelvedata' || (cfg.provider === 'auto' && !!cfg.tdKey);

  // ------------------------------------------------------------------ Charts

  function createCharts() {
    const base = {
      layout: { background: { color: 'transparent' }, textColor: COLORS.muted, fontSize: 11, fontFamily: 'JetBrains Mono, ui-monospace, monospace' },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.border, minimumWidth: 84 },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: LWC.CrosshairMode.Normal },
      localization: { locale: 'en-US' },
      autoSize: true,
    };
    const mainChart = LWC.createChart($('chart-main'), base);
    const candles = mainChart.addCandlestickSeries({
      upColor: COLORS.buy, downColor: COLORS.sell, borderVisible: false, wickUpColor: COLORS.buy, wickDownColor: COLORS.sell,
    });
    const lineMain = mainChart.addAreaSeries({
      lineColor: COLORS.accent, topColor: 'rgba(91,140,255,.25)', bottomColor: 'rgba(91,140,255,0)', lineWidth: 2, visible: false,
    });
    const overlay = (color, width = 2, style = 0) =>
      mainChart.addLineSeries({ color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const s = {
      candles, lineMain,
      ema20: overlay(COLORS.ema20),
      ema50: overlay(COLORS.ema50),
      ema200: overlay(COLORS.ema200),
      bbUp: overlay(COLORS.bb, 1, 2),
      bbMid: overlay('rgba(124,138,155,.35)', 1, 0),
      bbLow: overlay(COLORS.bb, 1, 2),
    };

    const oscChart = LWC.createChart($('chart-osc'), {
      ...base,
      layout: { ...base.layout, attributionLogo: false },
      timeScale: { ...base.timeScale, visible: false },
    });
    const line = (color, width = 2) => oscChart.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
    const osc = {
      rsi: [line('#c77dff')],
      macd: [
        oscChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }),
        line(COLORS.accent),
        line(COLORS.warn, 1),
      ],
      stoch: [line(COLORS.accent), line(COLORS.warn, 1)],
      adx: [line('#e3e9f1'), line(COLORS.buy, 1), line(COLORS.sell, 1)],
    };
    const guide = (series, price, color) =>
      series.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    guide(osc.rsi[0], 70, COLORS.sell);
    guide(osc.rsi[0], 30, COLORS.buy);
    guide(osc.rsi[0], 50, COLORS.border);
    guide(osc.stoch[0], 80, COLORS.sell);
    guide(osc.stoch[0], 20, COLORS.buy);
    guide(osc.adx[0], 25, COLORS.border);

    // Zeitachsen von Haupt- und Oszillator-Chart synchron halten.
    let syncing = false;
    const both = [mainChart, oscChart];
    for (const src of both) {
      src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        for (const dst of both) if (dst !== src) dst.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      });
    }

    mainChart.subscribeCrosshairMove((param) => {
      if (!main) return;
      const series = cfg.chartType === 'line' ? null : candles;
      const bar = param && param.time && series ? param.seriesData.get(series) : null;
      if (bar && bar.open !== undefined) renderOhlc(bar);
      else renderOhlc(main.res.candles[main.res.candles.length - 1]);
    });

    return { mainChart, oscChart, s, osc, lines: [] };
  }

  function renderOhlc(bar) {
    const p = main.pair;
    const chg = ((bar.close - bar.open) / bar.open) * 100;
    $('ohlc').innerHTML =
      `<span>O <b>${fmtPrice(p, bar.open)}</b></span><span>H <b>${fmtPrice(p, bar.high)}</b></span>` +
      `<span>L <b>${fmtPrice(p, bar.low)}</b></span><span>C <b>${fmtPrice(p, bar.close)}</b></span>` +
      `<span class="${chg >= 0 ? 'up' : 'down'}">${fmtPct(chg)}</span>`;
  }

  const toSeries = (candles, arr) => arr.map((v, i) => (v === null || v === undefined ? { time: candles[i].time } : { time: candles[i].time, value: v }));

  // Nächste bestätigte Swing-Hochs/-Tiefs über bzw. unter dem Kurs.
  function nearestLevels(x, i, count = 2) {
    const a = x.atr[i] || 0;
    const p = x.c[i];
    const res = x.pivots.highs.filter((j) => j + 3 <= i && j >= i - 200).map((j) => x.h[j]).filter((v) => v > p).sort((m, n) => m - n);
    const sup = x.pivots.lows.filter((j) => j + 3 <= i && j >= i - 200).map((j) => x.l[j]).filter((v) => v < p).sort((m, n) => n - m);
    const dedupe = (arr) => arr.reduce((out, v) => (out.every((o) => Math.abs(o - v) > a * 0.4) ? [...out, v] : out), []).slice(0, count);
    return { res: dedupe(res), sup: dedupe(sup) };
  }

  function renderChart(fit) {
    const { res, result, digits } = main;
    const candles = res.candles;
    const { x, signals, current } = result;
    const { s, osc } = charts;
    const fmt = { type: 'price', precision: digits, minMove: Math.pow(10, -digits) };
    for (const key of ['candles', 'lineMain', 'ema20', 'ema50', 'ema200', 'bbUp', 'bbMid', 'bbLow']) s[key].applyOptions({ priceFormat: fmt });
    const oscFmt = { type: 'price', precision: digits + 1, minMove: Math.pow(10, -(digits + 1)) };
    for (const series of osc.macd) series.applyOptions({ priceFormat: oscFmt });

    s.candles.setData(candles);
    s.lineMain.setData(candles.map((c) => ({ time: c.time, value: c.close })));
    s.ema20.setData(toSeries(candles, x.ema20));
    s.ema50.setData(toSeries(candles, x.ema50));
    s.ema200.setData(toSeries(candles, x.ema200));
    s.bbUp.setData(toSeries(candles, x.bb.upper));
    s.bbMid.setData(toSeries(candles, x.bb.mid));
    s.bbLow.setData(toSeries(candles, x.bb.lower));

    osc.rsi[0].setData(toSeries(candles, x.rsi));
    osc.macd[0].setData(x.macd.hist.map((v, i) => (v === null ? { time: candles[i].time } : {
      time: candles[i].time, value: v, color: v >= 0 ? 'rgba(31,201,142,.55)' : 'rgba(242,95,92,.55)',
    })));
    osc.macd[1].setData(toSeries(candles, x.macd.line));
    osc.macd[2].setData(toSeries(candles, x.macd.signal));
    osc.stoch[0].setData(toSeries(candles, x.stoch.k));
    osc.stoch[1].setData(toSeries(candles, x.stoch.d));
    osc.adx[0].setData(toSeries(candles, x.adx.adx));
    osc.adx[1].setData(toSeries(candles, x.adx.plusDI));
    osc.adx[2].setData(toSeries(candles, x.adx.minusDI));

    main.markers = signals.map((sg) => ({
      time: sg.time,
      position: sg.dir > 0 ? 'belowBar' : 'aboveBar',
      color: sg.dir > 0 ? COLORS.buy : COLORS.sell,
      shape: sg.dir > 0 ? 'arrowUp' : 'arrowDown',
      text: SHORT[sg.label],
    }));

    // Preislinien: Support/Widerstand und SL/TP.
    const target = cfg.chartType === 'line' ? s.lineMain : s.candles;
    for (const { series, line } of charts.lines) series.removePriceLine(line);
    charts.lines = [];
    const addLine = (price, color, title, style = 2) =>
      charts.lines.push({ series: target, line: target.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }) });
    if (cfg.overlays.sr && current) {
      const lv = nearestLevels(x, x.c.length - 1);
      lv.res.forEach((v, k) => addLine(v, 'rgba(242,181,68,.8)', `R${k + 1}`));
      lv.sup.forEach((v, k) => addLine(v, 'rgba(242,181,68,.8)', `S${k + 1}`));
    }
    if (cfg.overlays.levels && current && current.levels) {
      addLine(current.levels.stopLoss, COLORS.sell, 'SL', 0);
      addLine(current.levels.takeProfit1, COLORS.buy, 'TP1', 0);
      addLine(current.levels.takeProfit2, COLORS.buy, 'TP2', 0);
    }

    applyVisibility();
    if (fit) charts.mainChart.timeScale().setVisibleLogicalRange({ from: candles.length - 160, to: candles.length + 6 });
    renderOhlc(candles[candles.length - 1]);
    renderOscValue();
  }

  function applyVisibility() {
    const o = cfg.overlays;
    for (const b of $('overlays').querySelectorAll('button')) b.classList.toggle('on', !!o[b.dataset.o]);
    for (const b of $('chart-type').querySelectorAll('button')) b.classList.toggle('active', b.dataset.t === cfg.chartType);
    for (const b of $('osc-tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.k === cfg.osc);
    if (!charts) return;
    const { s, osc } = charts;
    const isLine = cfg.chartType === 'line';
    s.candles.applyOptions({ visible: !isLine });
    s.lineMain.applyOptions({ visible: isLine });
    s.ema20.applyOptions({ visible: o.ema20 });
    s.ema50.applyOptions({ visible: o.ema50 });
    s.ema200.applyOptions({ visible: o.ema200 });
    for (const k of ['bbUp', 'bbMid', 'bbLow']) s[k].applyOptions({ visible: o.bb });
    const markers = o.markers && main ? main.markers : [];
    s.candles.setMarkers(isLine ? [] : markers);
    s.lineMain.setMarkers(isLine ? markers : []);
    for (const [key, list] of Object.entries(osc)) for (const series of list) series.applyOptions({ visible: key === cfg.osc });
  }

  function renderOscValue() {
    if (!main) return;
    const x = main.result.x;
    const i = x.c.length - 1;
    const d = main.digits + 1;
    const f = (v, n = 1) => (v === null ? '–' : v.toFixed(n));
    const text = {
      rsi: `RSI ${f(x.rsi[i])}`,
      macd: `MACD ${f(x.macd.line[i], d)} · Signal ${f(x.macd.signal[i], d)} · Hist ${f(x.macd.hist[i], d)}`,
      stoch: `%K ${f(x.stoch.k[i])} · %D ${f(x.stoch.d[i])}`,
      adx: `ADX ${f(x.adx.adx[i])} · +DI ${f(x.adx.plusDI[i])} · −DI ${f(x.adx.minusDI[i])}`,
    };
    $('osc-val').textContent = text[cfg.osc];
  }

  // ------------------------------------------------------------------ Hauptbereich

  function renderHeader() {
    const { pair, res } = main;
    const candles = res.candles;
    const last = candles[candles.length - 1];
    const chg = changePct(candles, res.interval);
    const [b, q] = C.split(pair);
    $('pair-name').textContent = C.label(pair);
    $('ch-pair').textContent = C.label(pair);
    $('ch-name').textContent = `${C.CURRENCIES[b]} / ${C.CURRENCIES[q]} · ${TF_LABEL[res.interval]} · ${res.source}`;
    $('price').textContent = fmtPrice(pair, last.close);
    $('change').textContent = fmtPct(chg);
    $('change').className = 'change ' + (chg >= 0 ? 'up' : 'down');

    const pill = $('status-pill');
    pill.className = 'status-pill ' + res.kind;
    pill.textContent = res.kind === 'live' ? `LIVE · ${res.source}` : res.kind === 'daily' ? 'TAGESKURSE · EZB' : 'DEMO-DATEN';
    pill.title = res.errors && res.errors.length ? 'Nicht erreichbar: ' + res.errors.join(' | ') : res.source;

    let note = res.note;
    if (!note && res.kind === 'demo') {
      note = cfg.provider === 'demo'
        ? 'Demo-Modus: Die Kurse sind simuliert.'
        : 'Keine Live-Quelle erreichbar, daher simulierte Demo-Kurse. Für echte Kurse in den Einstellungen (⚙) einen kostenlosen Twelve-Data-Key eintragen.';
    }
    $('notice').hidden = !note;
    $('notice').textContent = note || '';

    const cur = main.result.current;
    document.title = `${cur ? SHORT[cur.label] + ' · ' : ''}${C.label(pair)} ${fmtPrice(pair, last.close)} – Forex Signal AI`;
  }

  function renderSignal() {
    const { pair, result, res } = main;
    const cur = result.current;
    const card = $('signal-card');
    if (!cur) {
      card.className = 'panel signal-card';
      $('signal-label').textContent = 'ZU WENIG DATEN';
      return;
    }
    card.className = `panel signal-card ${tone(cur.label)}${cur.label.startsWith('STRONG') ? ' strong' : ''}`;
    $('signal-label').textContent = cur.label;
    $('gauge-needle').style.left = `${50 + cur.score / 2}%`;
    $('score').textContent = signed(cur.score);
    $('confidence').textContent = `${cur.confidence.toFixed(0)} %`;
    const pip = C.pipSize(pair, cur.price);
    $('atr').textContent = cur.atr !== null ? `${(cur.atr / pip).toFixed(1)} P` : '–';
    $('sc-meta').textContent = `${C.label(pair)} · ${TF_LABEL[res.interval]} · ${new Date().toLocaleTimeString('de-DE')}`;

    const lv = cur.levels;
    if (lv) {
      const row = (name, v, cls) => {
        const pips = (v - lv.entry) / pip;
        return `<span>${name}</span><span class="${cls}">${fmtPrice(pair, v)}</span><span>${name === 'Entry' ? 'Markt' : signed(pips) + ' P'}</span>`;
      };
      $('levels').innerHTML =
        row('Entry', lv.entry, '') + row('Stop-Loss', lv.stopLoss, 'sl') +
        row('Take-Profit 1', lv.takeProfit1, 'tp') + row('Take-Profit 2', lv.takeProfit2, 'tp') +
        `<p>SL = 1,5 × ATR · TP2 mit Chance/Risiko 1 : ${lv.riskReward}</p>`;
    } else {
      $('levels').innerHTML = '<p>Kein klares Setup. Abwarten, bis sich die Analysen einig sind.</p>';
    }

    $('analyses').innerHTML = cur.results
      .map((r) => {
        const cls = r.score > 0.15 ? 'buy' : r.score < -0.15 ? 'sell' : 'neutral';
        const text = { buy: 'Bullisch', sell: 'Bärisch', neutral: 'Neutral' }[cls];
        const w = Math.abs(r.score) * 50;
        return `<li>
          <span class="name">${esc(r.name)} <small>×${r.weight}</small></span>
          <span class="verdict ${cls}">${text}</span>
          <div class="bar"><span style="left:${r.score >= 0 ? 50 : 50 - w}%;width:${w}%;background:${r.score >= 0 ? 'var(--buy)' : 'var(--sell)'}"></span></div>
          <span class="detail">${esc(r.detail)}</span>
        </li>`;
      })
      .join('');

    const bt = result.backtest;
    $('backtest').innerHTML = bt.rate === null
      ? 'Noch keine auswertbaren Signale.'
      : `<b>${bt.rate.toFixed(0)} %</b> Trefferquote bei ${bt.total} Signalwechseln (Kurs ${bt.horizon} Kerzen später in Signalrichtung).`;
    $('recent').innerHTML = result.signals
      .slice(-6)
      .reverse()
      .map((sg) => `<li><span class="${sg.dir > 0 ? 'b' : 's'}">${SHORT[sg.label]}</span><span>${fmtPrice(pair, sg.price)}</span><span class="muted">${fmtTime(sg.time)}</span></li>`)
      .join('');
  }

  // ------------------------------------------------------------------ Multi-Timeframe

  async function loadMTF(force) {
    const pair = cfg.pair;
    const fresh = mtfState.pair === pair && Date.now() - mtfState.at < (usesTwelveData() ? 300e3 : 60e3);
    if (fresh && !force) {
      if (main && main.pair === pair) mtfState.rows[main.interval] = { current: main.result.current };
      renderMTF();
      return;
    }
    mtfState = { pair, at: Date.now(), rows: {} };
    if (main && main.pair === pair) mtfState.rows[main.interval] = { current: main.result.current };
    renderMTF();
    for (const [tf] of MTF) {
      if (mtfState.pair !== pair) return;
      if (mtfState.rows[tf]) continue;
      try {
        const r = await D.getCandles(pair, tf, { limit: 300 });
        if (mtfState.pair !== pair) return;
        mtfState.rows[tf] = r.interval === tf
          ? { current: S.quick(r.candles, C.digits(pair, r.candles[r.candles.length - 1].close)) }
          : { missing: true };
      } catch (e) {
        mtfState.rows[tf] = { missing: true };
      }
      renderMTF();
    }
  }

  function renderMTF() {
    let wsum = 0, total = 0, n = 0;
    $('mtf').innerHTML = MTF.map(([tf, w]) => {
      const row = mtfState.rows[tf];
      const cur = row && row.current;
      const cls = main && main.interval === tf ? 'current' : '';
      if (!row) return `<tr class="${cls}"><td>${TF_LABEL[tf]}</td><td>${chip(null)}</td><td></td><td>…</td></tr>`;
      if (!cur) return `<tr class="${cls}"><td>${TF_LABEL[tf]}</td><td><span class="chip">k. A.</span></td><td class="muted">keine Daten</td><td>–</td></tr>`;
      wsum += w;
      total += w * cur.score;
      n++;
      const wd = Math.min(50, Math.abs(cur.score) / 2);
      return `<tr class="${cls}"><td>${TF_LABEL[tf]}</td><td>${chip(cur.label)}</td>
        <td><div class="bar"><span style="left:${cur.score >= 0 ? 50 : 50 - wd}%;width:${wd}%;background:${cur.score >= 0 ? 'var(--buy)' : 'var(--sell)'}"></span></div></td>
        <td>${signed(cur.score, 0)}</td></tr>`;
    }).join('');
    const el = $('mtf-consensus');
    if (!n) { el.textContent = '–'; el.className = ''; return; }
    const label = S.labelFor(total / wsum);
    let agree = 0;
    for (const [tf] of MTF) {
      const cur = mtfState.rows[tf] && mtfState.rows[tf].current;
      if (cur && dirOf(cur.label) === dirOf(label)) agree++;
    }
    el.textContent = `${SHORT[label]} ${agree}/${n}`;
    el.className = tone(label) === 'buy' ? 'up' : tone(label) === 'sell' ? 'down' : '';
  }

  // ------------------------------------------------------------------ Positionsrechner

  function knownRates() {
    const known = {};
    for (const [p, e] of scan) if (e.price) known[p] = e.price;
    if (main) known[main.pair] = main.res.candles[main.res.candles.length - 1].close;
    return known;
  }

  function renderCalc() {
    if (!main || !main.result.current) return;
    const { pair } = main;
    const cur = main.result.current;
    const [b, q] = C.split(pair);
    const pip = C.pipSize(pair, cur.price);
    const acc = cfg.acc;
    if (!slManual) {
      const dist = cur.levels ? Math.abs(cur.levels.entry - cur.levels.stopLoss) : (cur.atr || 0) * 1.5;
      $('acc-sl').value = (dist / pip).toFixed(1);
    }
    const slPips = parseFloat($('acc-sl').value) || 0;
    const known = knownRates();
    const pipValueLot = pip * 100000 * D.rate(q, acc.ccy, known);
    const riskAmt = acc.balance * (acc.risk / 100);
    const lots = slPips > 0 && pipValueLot > 0 ? riskAmt / (slPips * pipValueLot) : 0;
    const units = lots * 100000;
    const margin = (units * D.rate(b, acc.ccy, known)) / 30;
    const rows = [
      ['Risikobetrag', money(riskAmt, acc.ccy)],
      ['Positionsgröße', `${lots.toFixed(2)} Lots`, 'big'],
      ['Einheiten', Math.round(units).toLocaleString('de-DE')],
      ['Pip-Wert je Lot', money(pipValueLot, acc.ccy)],
      ['Gewinn bei TP1 (1:1)', money(riskAmt, acc.ccy)],
      ['Gewinn bei TP2 (1:2)', money(riskAmt * 2, acc.ccy)],
      ['Margin bei Hebel 1:30', money(margin, acc.ccy)],
    ];
    $('calc-out').innerHTML = rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('');
  }

  // ------------------------------------------------------------------ Watchlist-Scan

  function updateScan(pair, res, current) {
    const candles = res.candles;
    const last = candles[candles.length - 1];
    const cur = current !== undefined ? current : S.quick(candles, C.digits(pair, last.close));
    const prev = scan.get(pair);
    const entry = {
      pair,
      price: last.close,
      chg: changePct(candles, res.interval),
      spark: candles.slice(-48).map((c) => c.close),
      label: cur ? cur.label : null,
      score: cur ? cur.score : 0,
      kind: res.kind,
      interval: res.interval,
      source: res.source,
    };
    if (prev && prev.label && entry.label && prev.interval === entry.interval) {
      const dNew = dirOf(entry.label);
      if (dNew !== 0 && dNew !== dirOf(prev.label)) addAlert(pair, prev.label, entry.label, entry.price, entry.interval);
    }
    scan.set(pair, entry);
    scheduleWatchlist();
  }

  async function runScan() {
    if (scanning) return;
    scanning = true;
    const interval = cfg.interval;
    const pairs = [...new Set([...cfg.watchlist, ...C.MAJORS])];
    const concurrency = usesTwelveData() ? 1 : 4;
    let idx = 0, done = 0;
    $('scan-state').textContent = `Scanne ${pairs.length} Paare …`;
    const worker = async () => {
      while (idx < pairs.length) {
        const pair = pairs[idx++];
        if (!(main && main.pair === pair && main.requested === interval)) {
          try {
            const res = await D.getCandles(pair, interval, { limit: 300 });
            if (cfg.interval === interval) updateScan(pair, res);
          } catch (e) { /* Paar bleibt ohne Daten */ }
        }
        done++;
        $('scan-state').textContent = `Scanne ${done}/${pairs.length} Paare …`;
        renderOverview();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    scanning = false;
    $('scan-state').textContent = `${pairs.length} Paare gescannt · ${new Date().toLocaleTimeString('de-DE')}`;
    renderOverview();
    renderCalc();
  }

  let wlFrame = 0;
  function scheduleWatchlist() {
    if (wlFrame) return;
    wlFrame = requestAnimationFrame(() => { wlFrame = 0; renderWatchlist(); });
  }

  function renderWatchlist() {
    const q = $('wl-search').value.trim().toUpperCase().replace('/', '');
    let list = cfg.watchlist.slice();
    if (cfg.wlFilter === 'fav') list = list.filter((p) => cfg.favorites.includes(p));
    else if (cfg.wlFilter !== 'all') list = list.filter((p) => C.category(p) === cfg.wlFilter);
    if (q) list = list.filter((p) => p.includes(q) || C.split(p).some((c) => C.CURRENCIES[c].toUpperCase().includes(q)));
    const e = (p) => scan.get(p) || {};
    const sorters = {
      'score-desc': (a, b) => (e(b).score || 0) - (e(a).score || 0),
      'score-asc': (a, b) => (e(a).score || 0) - (e(b).score || 0),
      abs: (a, b) => Math.abs(e(b).score || 0) - Math.abs(e(a).score || 0),
      'chg-desc': (a, b) => (e(b).chg || 0) - (e(a).chg || 0),
      'chg-asc': (a, b) => (e(a).chg || 0) - (e(b).chg || 0),
      name: (a, b) => a.localeCompare(b),
    };
    if (sorters[cfg.wlSort]) list.sort(sorters[cfg.wlSort]);

    if (!list.length) {
      $('wl-list').innerHTML = `<li class="wl-empty">${cfg.wlFilter === 'fav' ? 'Noch keine Favoriten. Tippe auf ☆ neben einem Paar.' : 'Keine Paare gefunden.'}</li>`;
      return;
    }
    $('wl-list').innerHTML = list
      .map((p) => {
        const x = e(p);
        const fav = cfg.favorites.includes(p);
        const up = (x.chg || 0) >= 0;
        const kindTitle = { live: 'Live-Daten', daily: 'EZB-Tageskurse', demo: 'Demo-Daten' }[x.kind] || 'lädt';
        return `<li class="wl-row${main && main.pair === p ? ' active' : ''}" data-pair="${p}" tabindex="0">
          <button class="wl-star${fav ? ' on' : ''}" data-act="fav" title="Favorit" aria-label="Favorit">${fav ? '★' : '☆'}</button>
          <span class="wl-pair"><b>${C.label(p)}</b>
            <small><span class="src-dot ${x.kind || ''}" title="${kindTitle}${x.interval && x.interval !== cfg.interval ? ' · ' + TF_LABEL[x.interval] : ''}"></span>${x.spark ? sparkline(x.spark, up) : ''}</small></span>
          <span class="wl-quote">${x.price ? fmtPrice(p, x.price) : '–'}<small class="${up ? 'up' : 'down'}">${x.chg !== undefined ? fmtPct(x.chg) : ''}</small></span>
          ${chip(x.label)}
          <button class="wl-remove" data-act="remove" title="Aus Watchlist entfernen" aria-label="Entfernen">✕</button>
        </li>`;
      })
      .join('');
  }

  // ------------------------------------------------------------------ Übersicht

  const SESSIONS = [
    { name: 'Sydney', tz: 'Australia/Sydney', open: 7, close: 16 },
    { name: 'Tokio', tz: 'Asia/Tokyo', open: 9, close: 18 },
    { name: 'London', tz: 'Europe/London', open: 8, close: 17 },
    { name: 'New York', tz: 'America/New_York', open: 8, close: 17 },
  ];

  function localParts(tz, date) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(date);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    return { wd: get('weekday'), h: +get('hour') % 24, m: +get('minute') };
  }

  // Forex handelt von Sonntag 17:00 bis Freitag 17:00 New Yorker Zeit.
  function fxMarketOpen(date) {
    const ny = localParts('America/New_York', date);
    if (ny.wd === 'Sat') return false;
    if (ny.wd === 'Fri' && ny.h >= 17) return false;
    if (ny.wd === 'Sun' && ny.h < 17) return false;
    return true;
  }

  function renderSessions() {
    const now = new Date();
    const marketOpen = fxMarketOpen(now);
    const openNames = [];
    $('sessions').innerHTML = SESSIONS.map((s) => {
      const lp = localParts(s.tz, now);
      const hours = lp.h + lp.m / 60;
      const weekday = !['Sat', 'Sun'].includes(lp.wd);
      const open = marketOpen && weekday && hours >= s.open && hours < s.close;
      if (open) openNames.push(s.name);
      const progress = open ? ((hours - s.open) / (s.close - s.open)) * 100 : 0;
      const hhmm = `${String(lp.h).padStart(2, '0')}:${String(lp.m).padStart(2, '0')}`;
      return `<li class="${open ? 'open' : 'closed'}"><span class="s-name">${s.name}</span>
        <span class="s-track" title="${open ? 'geöffnet' : 'geschlossen'} (${s.open}–${s.close} Uhr Ortszeit)"><span class="s-fill" style="width:${progress}%"></span></span>
        <span class="s-time">${hhmm}</span></li>`;
    }).join('');
    let text;
    if (!marketOpen) text = 'Markt geschlossen (Wochenende). Handel startet Sonntag 17:00 New Yorker Zeit.';
    else if (openNames.includes('London') && openNames.includes('New York')) text = 'London und New York überlappen: höchste Liquidität des Tages.';
    else if (openNames.length) text = `Aktiv: ${openNames.join(', ')}`;
    else text = 'Ruhige Phase zwischen den Hauptsitzungen.';
    $('market-state').textContent = text;

    const pad = (n) => String(n).padStart(2, '0');
    $('clock').textContent = `${pad(now.getHours())}:${pad(now.getMinutes())} · UTC ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
  }

  function renderOverview() {
    // Währungsstärke aus den 7 Majors: Bewegung gegen USD minus Durchschnitt aller Währungen.
    const r = { USD: 0 };
    let complete = true;
    for (const p of C.MAJORS) {
      const e = scan.get(p);
      if (!e || e.chg === null || e.chg === undefined) { complete = false; continue; }
      const [b, q] = C.split(p);
      if (q === 'USD') r[b] = e.chg; else r[q] = -e.chg;
    }
    const ccys = Object.keys(r);
    if (ccys.length >= 4) {
      const mean = ccys.reduce((s, c) => s + r[c], 0) / ccys.length;
      const vals = ccys.map((c) => [c, r[c] - mean]).sort((a, b) => b[1] - a[1]);
      const max = Math.max(...vals.map((v) => Math.abs(v[1])), 0.01);
      $('strength').innerHTML = vals.map(([c, v]) => {
        const w = (Math.abs(v) / max) * 50;
        return `<li title="${C.CURRENCIES[c]}"><span>${c}</span><span class="bar2"><span style="left:${v >= 0 ? 50 : 50 - w}%;width:${w}%;background:${v >= 0 ? 'var(--buy)' : 'var(--sell)'}"></span></span><span class="v">${signed(v, 2)}%</span></li>`;
      }).join('');
      const e = scan.get('EURUSD');
      const basis = e && D.INTERVALS[e.interval] >= 86400 ? (e.interval === '1w' ? 'vs. Vorwoche' : 'vs. Vortag') : '24h';
      $('strength-tf').textContent = basis + (complete ? '' : ' · lädt');
    }

    // Top-Signale und Stimmung über die Watchlist.
    const entries = cfg.watchlist.map((p) => scan.get(p)).filter((e) => e && e.label);
    const buys = entries.filter((e) => dirOf(e.label) > 0).sort((a, b) => b.score - a.score).slice(0, 4);
    const sells = entries.filter((e) => dirOf(e.label) < 0).sort((a, b) => a.score - b.score).slice(0, 4);
    const item = (e) => `<li><button data-pair="${e.pair}"><span>${C.label(e.pair)}</span><span class="${e.score >= 0 ? 'up' : 'down'}">${signed(e.score, 0)}</span></button></li>`;
    $('top-buy').innerHTML = buys.length ? buys.map(item).join('') : '<li class="empty">Kein Buy-Signal</li>';
    $('top-sell').innerHTML = sells.length ? sells.map(item).join('') : '<li class="empty">Kein Sell-Signal</li>';

    const counts = { buy: 0, neutral: 0, sell: 0 };
    for (const e of entries) counts[tone(e.label)]++;
    const total = entries.length || 1;
    const seg = (k, color) => (counts[k] ? `<span style="flex-grow:${counts[k]};background:${color}">${Math.round((counts[k] / total) * 100)}%</span>` : '');
    $('sent-bar').innerHTML = seg('buy', 'var(--buy)') + seg('neutral', 'var(--warn)') + seg('sell', 'var(--sell)');
    const avg = entries.reduce((s, e) => s + e.score, 0) / total;
    $('sent-legend').innerHTML =
      `<span><i class="dot" style="background:var(--buy)"></i>Buy <b>${counts.buy}</b></span>` +
      `<span><i class="dot" style="background:var(--warn)"></i>Neutral <b>${counts.neutral}</b></span>` +
      `<span><i class="dot" style="background:var(--sell)"></i>Sell <b>${counts.sell}</b></span>` +
      `<span>Ø Score <b class="${avg >= 0 ? 'up' : 'down'}">${signed(avg)}</b></span>`;
  }

  // ------------------------------------------------------------------ Alarme

  function addAlert(pair, from, to, price, interval) {
    alerts.unshift({ pair, from, to, price, interval, at: Date.now() });
    alerts.length = Math.min(alerts.length, 30);
    const msg = `${C.label(pair)} (${TF_LABEL[interval]}): ${SHORT[from]} → ${SHORT[to]} bei ${fmtPrice(pair, price)}`;
    toast(msg, tone(to));
    try {
      if (window.Notification && Notification.permission === 'granted') new Notification('Forex Signal AI', { body: msg });
    } catch (e) { /* Benachrichtigungen nicht verfügbar */ }
    $('alerts').innerHTML = alerts
      .map((a) => `<li><button data-pair="${a.pair}">${C.label(a.pair)}</button><span class="${dirOf(a.to) > 0 ? 'b' : 's'}">${SHORT[a.from]} → ${SHORT[a.to]}</span><span class="muted">${fmtTime(a.at / 1000, false)}</span></li>`)
      .join('');
  }

  // ------------------------------------------------------------------ Laden

  async function loadMain(fit) {
    const seq = ++mainSeq;
    const pair = cfg.pair;
    const interval = cfg.interval;
    $('refresh').classList.add('spin');
    try {
      const res = await D.getCandles(pair, interval);
      if (seq !== mainSeq) return;
      const digits = C.digits(pair, res.candles[res.candles.length - 1].close);
      const result = S.analyze(res.candles, digits);
      main = { pair, interval: res.interval, requested: interval, res, result, digits };
      renderHeader();
      renderChart(fit);
      renderSignal();
      renderCalc();
      updateScan(pair, res, result.current);
      loadMTF(fit);
    } catch (e) {
      console.error(e);
      $('notice').hidden = false;
      $('notice').textContent = `Daten für ${C.label(pair)} konnten nicht geladen werden: ${e.message}`;
    } finally {
      if (seq === mainSeq) $('refresh').classList.remove('spin');
    }
  }

  async function cycle() {
    await loadMain(false);
    runScan();
  }

  function schedule() {
    clearInterval(timer);
    let sec = cfg.refresh;
    if (!sec) return;
    if (usesTwelveData()) sec = Math.max(sec, 300);
    timer = setInterval(cycle, sec * 1000);
  }

  function selectPair(pair) {
    if (!validPair(pair)) return;
    cfg.pair = pair;
    slManual = false;
    saveConfig();
    $('pair-name').textContent = C.label(pair);
    scheduleWatchlist();
    loadMain(true);
  }

  function selectInterval(tf) {
    cfg.interval = tf;
    saveConfig();
    for (const b of $('intervals').querySelectorAll('button')) b.classList.toggle('active', b.dataset.i === tf);
    scan.clear();
    scheduleWatchlist();
    loadMain(true).then(runScan);
  }

  // ------------------------------------------------------------------ Paar-Auswahl

  let palItems = [];
  let palFocus = 0;

  function renderPalette() {
    const q = $('pal-search').value.trim().toUpperCase().replace(/[\s/]/g, '');
    const match = (p) => !q || p.includes(q) || C.split(p).some((c) => C.CURRENCIES[c].toUpperCase().includes(q));
    const groups = [
      ['Watchlist', cfg.watchlist],
      ['Majors', C.MAJORS],
      ['Minors', C.MINORS],
      ['Exoten', C.EXOTICS],
    ];
    if (q.length === 6 && validPair(q) && !C.allPairs().includes(q) && !cfg.watchlist.includes(q)) groups.unshift(['Eigenes Paar', [q]]);
    palItems = [];
    let html = '';
    const shown = new Set();
    for (const [name, pairs] of groups) {
      const list = pairs.filter((p) => match(p) && !shown.has(p));
      list.forEach((p) => shown.add(p));
      if (!list.length) continue;
      html += `<div class="pal-group">${name}</div>`;
      for (const p of list) {
        const idx = palItems.push(p) - 1;
        const [b, qq] = C.split(p);
        const inWl = cfg.watchlist.includes(p);
        html += `<div class="pal-item${idx === palFocus ? ' focus' : ''}" data-pair="${p}">
          <b>${C.label(p)}</b><span>${C.CURRENCIES[b]} / ${C.CURRENCIES[qq]}</span>
          <button class="small-btn${inWl ? ' in' : ''}" data-act="toggle">${inWl ? '✓ Watchlist' : '+ Watchlist'}</button></div>`;
      }
    }
    $('pal-list').innerHTML = html || '<div class="pal-group">Nichts gefunden</div>';
  }

  function openPalette() {
    $('pal-search').value = '';
    palFocus = 0;
    renderPalette();
    $('palette').showModal();
    $('pal-search').focus();
  }

  function toggleWatchlist(pair) {
    if (!validPair(pair)) return;
    if (cfg.watchlist.includes(pair)) {
      cfg.watchlist = cfg.watchlist.filter((p) => p !== pair);
    } else {
      cfg.watchlist.push(pair);
      const interval = cfg.interval;
      D.getCandles(pair, interval, { limit: 300 }).then((r) => { if (cfg.interval === interval) updateScan(pair, r); }).catch(() => {});
    }
    saveConfig();
    scheduleWatchlist();
    renderOverview();
  }

  // ------------------------------------------------------------------ Events

  function bindEvents() {
    $('intervals').addEventListener('click', (e) => {
      const tf = e.target.dataset && e.target.dataset.i;
      if (tf && tf !== cfg.interval) selectInterval(tf);
    });
    $('refresh').addEventListener('click', () => { mtfState.at = 0; cycle(); });
    $('pair-btn').addEventListener('click', openPalette);
    $('wl-add').addEventListener('click', openPalette);

    $('overlays').addEventListener('click', (e) => {
      const k = e.target.dataset && e.target.dataset.o;
      if (!k) return;
      cfg.overlays[k] = !cfg.overlays[k];
      saveConfig();
      if (main && (k === 'sr' || k === 'levels')) renderChart(false); else applyVisibility();
    });
    $('chart-type').addEventListener('click', (e) => {
      const t = e.target.dataset && e.target.dataset.t;
      if (!t) return;
      cfg.chartType = t;
      saveConfig();
      if (main) renderChart(false); else applyVisibility();
    });
    $('osc-tabs').addEventListener('click', (e) => {
      const k = e.target.dataset && e.target.dataset.k;
      if (!k) return;
      cfg.osc = k;
      saveConfig();
      applyVisibility();
      renderOscValue();
    });

    // Watchlist
    $('wl-tabs').addEventListener('click', (e) => {
      const f = e.target.dataset && e.target.dataset.f;
      if (!f) return;
      cfg.wlFilter = f;
      saveConfig();
      for (const b of $('wl-tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.f === f);
      renderWatchlist();
    });
    $('wl-search').addEventListener('input', renderWatchlist);
    $('wl-sort').addEventListener('change', (e) => { cfg.wlSort = e.target.value; saveConfig(); renderWatchlist(); });
    $('wl-list').addEventListener('click', (e) => {
      const row = e.target.closest('.wl-row');
      if (!row) return;
      const pair = row.dataset.pair;
      const act = e.target.closest('[data-act]');
      if (act && act.dataset.act === 'fav') {
        cfg.favorites = cfg.favorites.includes(pair) ? cfg.favorites.filter((p) => p !== pair) : [...cfg.favorites, pair];
        saveConfig();
        renderWatchlist();
      } else if (act && act.dataset.act === 'remove') {
        toggleWatchlist(pair);
      } else {
        selectPair(pair);
      }
    });
    $('wl-list').addEventListener('keydown', (e) => {
      const row = e.target.closest('.wl-row');
      if (row && e.key === 'Enter' && e.target === row) selectPair(row.dataset.pair);
    });

    // Klick auf Paare in Übersicht und Alarmen
    for (const id of ['top-buy', 'top-sell', 'alerts']) {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('[data-pair]');
        if (b) selectPair(b.dataset.pair);
      });
    }

    // Paar-Auswahl
    $('pal-search').addEventListener('input', () => { palFocus = 0; renderPalette(); });
    $('pal-search').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        palFocus = Math.max(0, Math.min(palItems.length - 1, palFocus + (e.key === 'ArrowDown' ? 1 : -1)));
        renderPalette();
        const f = $('pal-list').querySelector('.focus');
        if (f) f.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && palItems[palFocus]) {
        e.preventDefault();
        $('palette').close();
        selectPair(palItems[palFocus]);
      }
    });
    $('pal-list').addEventListener('click', (e) => {
      const item = e.target.closest('.pal-item');
      if (!item) return;
      if (e.target.closest('[data-act="toggle"]')) {
        toggleWatchlist(item.dataset.pair);
        renderPalette();
        return;
      }
      $('palette').close();
      selectPair(item.dataset.pair);
    });
    $('palette').addEventListener('click', (e) => {
      if (e.target === $('palette') || e.target.closest('[data-close]')) $('palette').close();
    });
    const builtPair = () => $('pal-base').value + $('pal-quote').value;
    $('pal-open').addEventListener('click', () => {
      if (!validPair(builtPair())) return toast('Basis- und Kurswährung müssen verschieden sein.');
      $('palette').close();
      selectPair(builtPair());
    });
    $('pal-add').addEventListener('click', () => {
      if (!validPair(builtPair())) return toast('Basis- und Kurswährung müssen verschieden sein.');
      if (!cfg.watchlist.includes(builtPair())) toggleWatchlist(builtPair());
      toast(`${C.label(builtPair())} ist in der Watchlist.`);
      renderPalette();
    });

    // Positionsrechner
    $('acc-ccy').addEventListener('change', (e) => { cfg.acc.ccy = e.target.value; saveConfig(); renderCalc(); });
    $('acc-balance').addEventListener('input', (e) => { cfg.acc.balance = Math.max(0, parseFloat(e.target.value) || 0); saveConfig(); renderCalc(); });
    $('acc-risk').addEventListener('input', (e) => { cfg.acc.risk = Math.max(0, parseFloat(e.target.value) || 0); saveConfig(); renderCalc(); });
    $('acc-sl').addEventListener('input', () => { slManual = true; renderCalc(); });
    $('calc').addEventListener('submit', (e) => e.preventDefault());

    // Einstellungen
    $('settings-btn').addEventListener('click', () => {
      $('set-provider').value = cfg.provider;
      $('set-tdkey').value = cfg.tdKey;
      $('set-refresh').value = String(cfg.refresh);
      $('settings').showModal();
    });
    $('set-reset').addEventListener('click', () => {
      cfg.watchlist = C.DEFAULT_WATCHLIST.slice();
      saveConfig();
      renderWatchlist();
      toast('Watchlist zurückgesetzt.');
      runScan();
    });
    $('settings-form').addEventListener('submit', (e) => {
      const submitter = e.submitter;
      if (!submitter || submitter.value !== 'save') return;
      cfg.provider = $('set-provider').value;
      cfg.tdKey = $('set-tdkey').value.trim();
      cfg.refresh = parseInt($('set-refresh').value, 10) || 0;
      saveConfig();
      D.configure({ provider: cfg.provider, tdKey: cfg.tdKey });
      scan.clear();
      mtfState.at = 0;
      schedule();
      toast('Einstellungen gespeichert. Lade Daten neu …');
      loadMain(true).then(runScan);
    });

    // Browser-Benachrichtigungen
    $('notify-btn').addEventListener('click', async () => {
      try {
        if (!window.Notification) throw new Error('nicht unterstützt');
        const p = await Notification.requestPermission();
        toast(p === 'granted' ? 'Benachrichtigungen aktiv.' : 'Benachrichtigungen wurden nicht erlaubt. Alarme erscheinen weiter auf der Seite.');
        updateNotifyBtn();
      } catch (e) {
        toast('Dieser Browser erlaubt hier keine Benachrichtigungen. Alarme erscheinen weiter auf der Seite.');
      }
    });

    // Tastatur: "/" öffnet die Suche, 1–6 wählen den Timeframe.
    document.addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input, select, textarea, dialog')) return;
      if (e.key === '/') { e.preventDefault(); openPalette(); return; }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= TFS.length && TFS[n - 1] !== cfg.interval) selectInterval(TFS[n - 1]);
    });
  }

  function updateNotifyBtn() {
    try {
      if (window.Notification && Notification.permission === 'granted') $('notify-btn').textContent = '✓ Benachrichtigungen';
    } catch (e) { /* ignorieren */ }
  }

  // ------------------------------------------------------------------ Start

  function init() {
    const opts = Object.entries(C.CURRENCIES).map(([c, n]) => `<option value="${c}">${c} · ${esc(n)}</option>`).join('');
    $('pal-base').innerHTML = opts;
    $('pal-quote').innerHTML = opts;
    $('pal-base').value = 'EUR';
    $('pal-quote').value = 'USD';
    $('acc-ccy').innerHTML = C.MAJOR_CCY.map((c) => `<option value="${c}">${c}</option>`).join('');
    $('acc-ccy').value = cfg.acc.ccy;
    $('acc-balance').value = cfg.acc.balance;
    $('acc-risk').value = cfg.acc.risk;
    $('wl-sort').value = cfg.wlSort;
    for (const b of $('wl-tabs').querySelectorAll('button')) b.classList.toggle('active', b.dataset.f === cfg.wlFilter);
    for (const b of $('intervals').querySelectorAll('button')) b.classList.toggle('active', b.dataset.i === cfg.interval);
    $('pair-name').textContent = C.label(cfg.pair);
    updateNotifyBtn();

    renderSessions();
    setInterval(renderSessions, 30e3);
    renderWatchlist();
    applyVisibility();
    bindEvents();

    if (!LWC) {
      $('notice').hidden = false;
      $('notice').textContent = 'Die Chart-Bibliothek konnte nicht geladen werden. Bitte Internetverbindung prüfen und neu laden.';
      return;
    }
    charts = createCharts();
    applyVisibility();
    loadMain(true).then(runScan);
    schedule();
  }

  init();
})();
