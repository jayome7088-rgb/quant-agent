// East Money (东方财富) API — direct HTTP, no API key, works from China.
// Replaces yahoo-api.ts which required Python yfinance + VPN.

// ---------------------------------------------------------------------------
// Types (same interface as before)
// ---------------------------------------------------------------------------

export interface OHLCVBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartResult {
  meta: {
    symbol: string;
    regularMarketPrice: number;
    previousClose: number;
    regularMarketTime: number;
    exchangeTimezoneName: string;
  };
  quotes: OHLCVBar[];
}

export interface QuoteResult {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  dayHigh: number;
  dayLow: number;
  volume: number;
  marketTime: number;
}

// ---------------------------------------------------------------------------
// Ticker normalization → East Money secid
// ---------------------------------------------------------------------------

export function normalizeTicker(raw: string): { symbol: string; market: string; secid: string } {
  const trimmed = raw.trim().toUpperCase();

  // Already has known suffix
  if (/\.(HK|SS|SZ|T|L|PA|V|TO|AX|SI|KS|KQ)$/.test(trimmed)) {
    const suffix = trimmed.split('.').pop()!;
    let code = trimmed.slice(0, -(suffix.length + 1));
    let secid = '';
    if (suffix === 'SS') secid = `1.${code}`;
    else if (suffix === 'SZ') secid = `0.${code}`;
    else if (suffix === 'HK') {
      code = code.padStart(5, '0');
      secid = `116.${code}`;
    }
    else secid = `105.${trimmed}`;
    return { symbol: trimmed, market: suffix, secid };
  }

  // US: 1-5 uppercase letters
  if (/^[A-Z]{1,5}$/.test(trimmed) || /^[A-Z]{1,5}[-.][AB]$/.test(trimmed)) {
    return { symbol: trimmed, market: 'US', secid: `105.${trimmed}` };
  }

  // Numeric tickers
  if (/^\d{4,6}$/.test(trimmed)) {
    if (trimmed.length === 6 && trimmed.startsWith('6')) {
      return { symbol: `${trimmed}.SS`, market: 'SS', secid: `1.${trimmed}` };
    }
    if (trimmed.length === 6 && /^[03]/.test(trimmed)) {
      return { symbol: `${trimmed}.SZ`, market: 'SZ', secid: `0.${trimmed}` };
    }
    // HK: pad to 5 digits for East Money (e.g., 0700 → 116.00700, 09868 → 116.09868)
    const hkCode = trimmed.padStart(5, '0');
    return { symbol: `${trimmed}.HK`, market: 'HK', secid: `116.${hkCode}` };
  }

  return { symbol: trimmed, market: 'unknown', secid: `105.${trimmed}` };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchJson(url: string, label: string): Promise<any> {
  let text = '';
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' },
      signal: AbortSignal.timeout(15_000),
    });
    text = await resp.text();
  } catch (err: any) {
    throw new Error(`[EastMoney] ${label}: request failed — ${err.message}`);
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`[EastMoney] ${label}: invalid JSON — ${text.slice(0, 200)}`);
  }

  if (data.rc !== 0 || data.data === null) {
    throw new Error(`[EastMoney] ${label}: API error (rc=${data.rc}) — ${text.slice(0, 200)}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// K-line interval mapping
// ---------------------------------------------------------------------------

function toKlt(interval: string): string {
  const map: Record<string, string> = {
    '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '60m': '60',
    '1d': '101', '1wk': '102', '1mo': '103',
  };
  return map[interval] ?? '101';
}

function rangeToLimit(range: string, interval: string): number {
  if (range === '5d') {
    const barsPerDay: Record<string, number> = { '1m': 240, '5m': 48, '15m': 16, '30m': 8, '60m': 4, '1h': 4 };
    return (barsPerDay[interval] ?? 48) * 5;
  }
  if (range === '1mo') return interval === '1d' ? 22 : 500;
  if (range === '3mo') return interval === '1d' ? 66 : 1000;
  if (range === '6mo') return interval === '1d' ? 132 : 2000;
  if (range === '1y') return 260;
  if (range === '2y') return 520;
  return 500;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchChart(
  ticker: string,
  interval: string,
  range: string,
): Promise<ChartResult> {
  const { symbol, secid } = normalizeTicker(ticker);
  const klt = toKlt(interval);
  const lmt = rangeToLimit(range, interval);

  const url = 'http://push2his.eastmoney.com/api/qt/stock/kline/get'
    + `?secid=${secid}`
    + '&fields1=f1,f2,f3,f4,f5,f6'
    + '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
    + `&klt=${klt}&fqt=1&lmt=${lmt}`;

  const data = await fetchJson(url, `chart ${ticker} (${interval}, ${range})`);

  const rawName: string = data.data.name ?? symbol;
  const klines: string[] = data.data.klines ?? [];
  if (klines.length === 0) {
    throw new Error(`[EastMoney] No kline data for ${ticker}`);
  }

  const quotes: OHLCVBar[] = [];
  for (const line of klines) {
    const parts = line.split(',');
    if (parts.length < 6) continue;
    const dateStr = parts[0];
    const ts = dateStr.length === 8
      ? Math.floor(new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T00:00:00+08:00`).getTime() / 1000)
      : dateStr.length > 10
        ? Math.floor(new Date(dateStr).getTime() / 1000)
        : Math.floor(Date.now() / 1000);

    quotes.push({
      timestamp: ts,
      open: parseFloat(parts[1]),
      close: parseFloat(parts[2]),
      high: parseFloat(parts[3]),
      low: parseFloat(parts[4]),
      volume: parseInt(parts[5], 10) || 0,
    });
  }

  const last = quotes[quotes.length - 1];
  const prevClose = quotes.length > 1 ? quotes[quotes.length - 2].close : last.open;

  return {
    meta: {
      symbol: rawName,
      regularMarketPrice: last.close,
      previousClose: prevClose,
      regularMarketTime: last.timestamp,
      exchangeTimezoneName: 'Asia/Shanghai',
    },
    quotes,
  };
}

export async function fetchQuote(ticker: string): Promise<QuoteResult> {
  const { symbol, market, secid } = normalizeTicker(ticker);
  const divisor = market === 'HK' ? 1000 : 100;

  const url = 'http://push2.eastmoney.com/api/qt/stock/get'
    + `?secid=${secid}`
    + '&fields=f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f169,f170';

  const data = await fetchJson(url, `quote ${ticker}`);
  const d = data.data ?? {};

  const price = (d.f43 ?? 0) / divisor;
  const prevClose = price - ((d.f169 ?? 0) / divisor);
  const change = (d.f169 ?? 0) / divisor;
  const changePct = d.f170 ?? 0;
  const high = (d.f44 ?? 0) / divisor;
  const low = (d.f45 ?? 0) / divisor;
  const volume = d.f47 ?? 0;

  return {
    symbol: d.f58 ?? symbol,
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePct * 100) / 100,
    dayHigh: Math.round(high * 100) / 100,
    dayLow: Math.round(low * 100) / 100,
    volume,
    marketTime: Math.floor(Date.now() / 1000),
  };
}
