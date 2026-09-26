/*
 * Währungen, Paar-Kategorien und Pip-Berechnung.
 */
(function (root) {
  'use strict';

  // Alle Währungen, für die es EZB-Referenzkurse gibt (plus USD).
  const CURRENCIES = {
    USD: 'US-Dollar', EUR: 'Euro', GBP: 'Britisches Pfund', JPY: 'Japanischer Yen',
    CHF: 'Schweizer Franken', AUD: 'Australischer Dollar', CAD: 'Kanadischer Dollar',
    NZD: 'Neuseeland-Dollar', SEK: 'Schwedische Krone', NOK: 'Norwegische Krone',
    DKK: 'Dänische Krone', PLN: 'Polnischer Zloty', HUF: 'Ungarischer Forint',
    CZK: 'Tschechische Krone', RON: 'Rumänischer Leu', BGN: 'Bulgarischer Lew',
    ISK: 'Isländische Krone', TRY: 'Türkische Lira', ZAR: 'Südafrikanischer Rand',
    MXN: 'Mexikanischer Peso', BRL: 'Brasilianischer Real', CNY: 'Chinesischer Yuan',
    HKD: 'Hongkong-Dollar', SGD: 'Singapur-Dollar', INR: 'Indische Rupie',
    KRW: 'Südkoreanischer Won', IDR: 'Indonesische Rupiah', THB: 'Thailändischer Baht',
    PHP: 'Philippinischer Peso', MYR: 'Malaysischer Ringgit', ILS: 'Israelischer Schekel',
  };

  const MAJOR_CCY = ['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];

  const MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD'];

  const MINORS = [
    'EURGBP', 'EURJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'EURNZD',
    'GBPJPY', 'GBPCHF', 'GBPAUD', 'GBPCAD', 'GBPNZD',
    'AUDJPY', 'AUDCHF', 'AUDCAD', 'AUDNZD',
    'CADJPY', 'CADCHF', 'CHFJPY',
    'NZDJPY', 'NZDCHF', 'NZDCAD',
  ];

  const EXOTICS = [
    'USDTRY', 'USDZAR', 'USDMXN', 'USDBRL', 'USDSEK', 'USDNOK', 'USDDKK',
    'USDPLN', 'USDHUF', 'USDCZK', 'USDRON', 'USDSGD', 'USDHKD', 'USDCNY',
    'USDINR', 'USDKRW', 'USDIDR', 'USDTHB', 'USDPHP', 'USDMYR', 'USDILS', 'USDISK',
    'EURTRY', 'EURSEK', 'EURNOK', 'EURPLN', 'EURHUF', 'EURCZK', 'EURDKK', 'EURZAR',
    'GBPZAR', 'GBPSEK', 'GBPNOK', 'GBPPLN', 'GBPTRY',
  ];

  const DEFAULT_WATCHLIST = [
    'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD',
    'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'EURCHF', 'USDTRY', 'USDMXN', 'USDZAR',
  ];

  // Ungefähre Kurse in USD – nur Startpunkt für Demo-Daten und Umrechnung ohne Live-Daten.
  const USD_VALUE = {
    USD: 1, EUR: 1.1, GBP: 1.3, JPY: 1 / 150, CHF: 1 / 0.85, AUD: 0.66, CAD: 1 / 1.37,
    NZD: 0.6, SEK: 1 / 10.5, NOK: 1 / 10.8, DKK: 1 / 6.8, PLN: 1 / 4, HUF: 1 / 360,
    CZK: 1 / 23, RON: 1 / 4.5, BGN: 1 / 1.78, ISK: 1 / 135, TRY: 1 / 40, ZAR: 1 / 18,
    MXN: 1 / 19, BRL: 1 / 5.5, CNY: 1 / 7.2, HKD: 1 / 7.8, SGD: 1 / 1.33, INR: 1 / 85,
    KRW: 1 / 1380, IDR: 1 / 16000, THB: 1 / 34, PHP: 1 / 57, MYR: 1 / 4.4, ILS: 1 / 3.6,
  };

  const split = (pair) => [pair.slice(0, 3), pair.slice(3, 6)];
  const label = (pair) => `${pair.slice(0, 3)}/${pair.slice(3, 6)}`;

  function category(pair) {
    if (MAJORS.includes(pair)) return 'major';
    const [b, q] = split(pair);
    if (MAJOR_CCY.includes(b) && MAJOR_CCY.includes(q)) return 'minor';
    return 'exotic';
  }

  // Pip-Größe: 0.01 für JPY-Paare, sonst abhängig von der Größenordnung des Kurses.
  function pipSize(pair, price) {
    const q = pair.slice(3, 6);
    if (q === 'JPY') return 0.01;
    const p = price ?? USD_VALUE[pair.slice(0, 3)] / USD_VALUE[q];
    if (p < 20) return 0.0001;
    if (p < 2000) return 0.01;
    return 1;
  }

  // Nachkommastellen für die Anzeige (eine mehr als die Pip-Stelle).
  function digits(pair, price) {
    const pip = pipSize(pair, price);
    return Math.max(0, Math.round(-Math.log10(pip)) + 1);
  }

  function allPairs() {
    return [...MAJORS, ...MINORS, ...EXOTICS];
  }

  const Currencies = {
    CURRENCIES, MAJOR_CCY, MAJORS, MINORS, EXOTICS, DEFAULT_WATCHLIST, USD_VALUE,
    split, label, category, pipSize, digits, allPairs,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Currencies;
  else root.Currencies = Currencies;
})(typeof self !== 'undefined' ? self : this);
