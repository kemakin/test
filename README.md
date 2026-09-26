# Forex Signal AI

Forex-Dashboard für alle gängigen Währungspaare: Watchlist mit Live-Signalen, Chart mit
Indikatoren und eine Empfehlung **STRONG BUY / BUY / NEUTRAL / SELL / STRONG SELL** aus neun
technischen Analysen.

## Starten

- **Ohne Installation:** `dist/forex-signal-ai.html` herunterladen und doppelklicken.
- **Entwicklung:** `npm start` → http://localhost:8080
- **Tests:** `npm test` · **Einzeldatei neu bauen:** `npm run build`

## Funktionen

**Übersicht**
- Handelssitzungen Sydney / Tokio / London / New York mit Ortszeit, Wochenend-Erkennung und Überlappungs-Hinweis
- Währungsstärke der 8 Majors (aus den 7 USD-Majors berechnet)
- Top-Signale: stärkste Buy- und Sell-Kandidaten der Watchlist
- Marktstimmung: Anteil Buy / Neutral / Sell und Durchschnitts-Score

**Watchlist**
- 63 vordefinierte Paare (7 Majors, 21 Minors, 35 Exoten) plus jede Kombination aus 31 Währungen
- Kurs, 24h-Veränderung, Sparkline, Signal und Datenquelle je Paar
- Favoriten, Filter (Majors/Minors/Exoten), Suche (auch nach Namen wie „Lira“), Sortierung nach Signalstärke oder Veränderung

**Chart**
- Kerzen oder Linie, Timeframes 5m / 15m / 1H / 4H / 1D / 1W
- EMA 20/50/200, Bollinger-Bänder, Support/Widerstand (R1/R2, S1/S2), Buy/Sell-Pfeile, SL/TP-Linien – einzeln schaltbar
- Oszillator-Panel: RSI, MACD, Stochastik oder ADX/DMI
- OHLC-Anzeige unter dem Mauszeiger

**Analyse**
- KI-Signal mit Score (−100 … +100), Konfidenz, ATR in Pips, Entry/SL/TP mit Pip-Abständen
- Multi-Timeframe-Analyse (15m bis 1W) mit gewichtetem Konsens
- Einzelanalysen mit Begründung
- Positionsrechner: Lots, Einheiten, Pip-Wert, Gewinn bei TP, Margin – in EUR, USD, GBP, JPY, CHF, AUD, CAD oder NZD
- Backtest der Signalwechsel und Liste der letzten Signale
- Alarme bei Signalwechseln in der Watchlist (auf der Seite und optional als Browser-Benachrichtigung)

Tastatur: `/` öffnet die Paarsuche, `1`–`6` wählen den Timeframe.

## Die Analysen

| Analyse | Gewicht | Idee |
|---|---|---|
| Trend (EMA 20/50/200) | 2.0 | Kurs und EMAs gestaffelt, Golden/Death Cross |
| MACD (12/26/9) | 1.5 | Crossover und Histogramm-Momentum |
| ADX / DMI (14) | 1.5 | Trendrichtung (+DI/−DI), gewichtet mit der Trendstärke |
| RSI (14) | 1.0 | überkauft/überverkauft, bullische/bärische Zone |
| Stochastik (14/3/3) | 1.0 | %K/%D-Crossover in Extremzonen |
| Bollinger-Bänder (20/2) | 1.0 | Mean Reversion über %B, Squeeze-Ausbrüche |
| Support / Widerstand | 1.0 | Abstand zu Swing-Hochs/-Tiefs, Ausbrüche |
| Momentum (ROC 10) | 0.75 | Rate of Change, normiert auf die ATR |
| Kerzenmuster | 0.75 | Engulfing, Hammer, Shooting Star, Doji |

Jede Analyse liefert −1 (bärisch) bis +1 (bullisch); der gewichtete Durchschnitt × 100 ist der Score.
≥ +45 STRONG BUY · ≥ +15 BUY · ≤ −15 SELL · ≤ −45 STRONG SELL · sonst NEUTRAL.
SL = 1,5 × ATR, TP1 = 1,5 × ATR, TP2 = 3 × ATR. Gewichte und Schwellen: `js/signal.js`.

## Datenquellen

Einstellbar über ⚙. Im Modus „Automatisch“ wird die erste funktionierende Quelle genommen:

| Quelle | Paare | Timeframes | Hinweis |
|---|---|---|---|
| **Twelve Data** | alle | alle | echte Forex-Kurse; kostenloser API-Key von twelvedata.com (8 Anfragen/Minute, 800/Tag) |
| **Binance** | Währungen mit USDT-Markt | alle | USDT als USD-Ersatz, Kreuzkurse aus zwei Märkten berechnet; handelt auch am Wochenende |
| **EZB** (Frankfurter) | alle 31 Währungen | nur 1D / 1W | offizielle Referenzkurse, einmal täglich |
| **Demo** | alle | alle | simulierte Kurse, wenn nichts erreichbar ist |

Welche Quelle gerade genutzt wird, zeigt die Statusanzeige oben rechts und der Punkt neben
jedem Watchlist-Paar (grün = live, gelb = Tageskurse, grau = Demo).

## Aufbau

```
index.html          Layout
css/style.css       Design
js/currencies.js    Währungen, Paar-Kategorien, Pip-Größen
js/indicators.js    EMA, RSI, MACD, Bollinger, Stochastik, ATR, ADX, Pivots …
js/signal.js        Einzelanalysen, Gesamtsignal, Backtest
js/data.js          Datenquellen, Kreuzkurse, Caching, Demo-Kurse
js/app.js           Dashboard-Logik
scripts/build.js    bündelt alles in dist/forex-signal-ai.html
```

## Hinweis

Keine Anlageberatung. Die Signale beruhen nur auf technischer Analyse vergangener Kurse und
können falsch sein. Forex-Handel mit Hebel kann zum Totalverlust führen.
