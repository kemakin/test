# Forex Signal AI – EUR/USD

Web-App, die EUR/USD (bzw. USD/EUR) analysiert, den Chart anzeigt und aus mehreren
technischen Analysen ein Signal ableitet: **STRONG BUY / BUY / NEUTRAL / SELL / STRONG SELL**.

## Starten

```bash
npm start          # http://localhost:8080
```

Oder `index.html` direkt im Browser öffnen. Es wird nichts installiert, die Chart-Bibliothek
(TradingView Lightweight Charts) kommt vom CDN.

## Was die App macht

- **Chart** mit Kerzen, EMA 20/50, Bollinger-Bändern, RSI- und MACD-Panel
- **Buy/Sell-Pfeile** an jedem historischen Signalwechsel
- **Stop-Loss und Take-Profit** (ATR-basiert) als Linien im Chart
- Timeframes 15m / 1H / 4H / 1D, Paar EUR/USD oder USD/EUR, Auto-Refresh jede Minute

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

Jede Analyse liefert einen Score von −1 (bärisch) bis +1 (bullisch). Der gewichtete
Durchschnitt × 100 ergibt den Gesamtscore:

- ≥ +45 STRONG BUY · ≥ +15 BUY · ≤ −15 SELL · ≤ −45 STRONG SELL · sonst NEUTRAL
- **Konfidenz** = Anteil des Gewichts, das in dieselbe Richtung zeigt
- **Levels**: SL = 1,5 × ATR, TP1 = 1,5 × ATR, TP2 = 3 × ATR (Chance/Risiko 1:2)
- **Backtest**: Trefferquote der bisherigen Signalwechsel (Kurs 10 Kerzen später in Signalrichtung)

Gewichte und Schwellen stehen in `js/signal.js` (`WEIGHTS`, `labelFor`).

## Datenquellen

1. Binance `EURUSDT` (echte OHLC-Kerzen, kein API-Key nötig)
2. Fallback: EZB-Referenzkurse über frankfurter.app (nur Tageskerzen)
3. Fallback: simulierte Demo-Daten, wenn keine Quelle erreichbar ist

Die aktive Quelle steht oben links unter dem Titel.

## Tests

```bash
npm test
```

## Hinweis

Keine Anlageberatung. Die Signale basieren nur auf technischer Analyse vergangener Kurse
und können falsch sein.
