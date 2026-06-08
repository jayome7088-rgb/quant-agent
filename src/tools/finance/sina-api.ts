// Sina Finance (新浪财经) API — free, no API key, reliable in China.
// Primary data source for QuantAgent. Replaces East Money entirely.
//
// Quote:  http://hq.sinajs.cn/list=hk09626  (GBK encoded)
// K-line: https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/
//         CN_MarketData.getKLineData?symbol=hk09626&scale=240&datalen=500
//
// HK codes ALWAYS preserved as strings with leading zeros — never converted to numbers.
// GBK responses decoded with TextDecoder('gbk'), never response.text().

import type { OHLCVBar, ChartResult } from './eastmoney-api.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const REFERER = 'https://finance.sina.com.cn/';
const TIMEOUT_MS = 10_000;

// ═══════════════════════════════════════════════════════════════════════════
// Ticker mapping — HK codes ALWAYS kept as strings, NEVER converted to numbers
// ═══════════════════════════════════════════════════════════════════════════

export function toSinaSymbol(ticker: string): { symbol: string; prefix: string; code: string } | null {
  const t = ticker.trim().toUpperCase();

  if (t.endsWith('.HK')) {
    const code = t.slice(0, -3); // "09626" — keep leading zeros!
    return { symbol: `hk${code}`, prefix: 'hk', code };
  }
  if (t.endsWith('.SS')) {
    const code = t.slice(0, -3);
    return { symbol: `sh${code}`, prefix: 'sh', code };
  }
  if (t.endsWith('.SZ')) {
    const code = t.slice(0, -3);
    return { symbol: `sz${code}`, prefix: 'sz', code };
  }

  if (/^\d{6}$/.test(t) && t.startsWith('6')) {
    return { symbol: `sh${t}`, prefix: 'sh', code: t };
  }
  if (/^\d{6}$/.test(t) && /^[03]/.test(t)) {
    return { symbol: `sz${t}`, prefix: 'sz', code: t };
  }
  // HK: 4-5 digit code — keep as string with leading zeros
  if (/^\d{4,5}$/.test(t)) {
    const code = t.padStart(5, '0'); // "9626" → "09626"
    return { symbol: `hk${code}`, prefix: 'hk', code };
  }

  if (/^[A-Z]{1,5}$/.test(t)) {
    return { symbol: `gb_${t.toLowerCase()}`, prefix: 'gb', code: t };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTTP helpers — single retry, GBK decode, Referer always set
// ═══════════════════════════════════════════════════════════════════════════

async function fetchWithRetry(url: string, retries = 1): Promise<Response> {
  let lastErr: Error | null = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Referer': REFERER,
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return resp;
    } catch (e) {
      lastErr = e as Error;
      if (i < retries) await new Promise(r => setTimeout(r, 500));
    }
  }
  throw lastErr!;
}

/** Fetch GBK-encoded text from Sina (used for real-time quotes). */
async function fetchGbkText(url: string, label: string): Promise<string> {
  const resp = await fetchWithRetry(url);
  if (!resp.ok) throw new Error(`[Sina] ${label}: HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const decoder = new TextDecoder('gbk');
  return decoder.decode(buf);
}

/** Fetch JSON from Sina K-line API. */
async function fetchSinaJson(url: string, label: string): Promise<any> {
  const resp = await fetchWithRetry(url);
  if (!resp.ok) throw new Error(`[Sina] ${label}: HTTP ${resp.status}`);
  const text = await resp.text();
  return JSON.parse(text);
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

export interface QuoteResult {
  symbol: string; price: number; change: number; changePercent: number;
  dayHigh: number; dayLow: number; volume: number; marketTime: number;
}

export async function fetchSinaQuote(ticker: string): Promise<QuoteResult> {
  const sina = toSinaSymbol(ticker);
  if (!sina) throw new Error(`[Sina] Cannot map ticker: ${ticker}`);

  // Cache bust: append timestamp to force fresh data
  const url = `http://hq.sinajs.cn/list=${sina.symbol}&_=${Date.now()}`;
  console.log(`[sina] Quote: ${url}`);
  const text = await fetchGbkText(url, `quote ${ticker}`);

  // HK format: var hq_str_hk09626="NAME,OPEN,PREV,PRICE,HIGH,LOW,BUY,SELL,VOL,..."
  const match = text.match(/"([^"]*)"/);
  if (!match || !match[1]) {
    throw new Error(`[Sina] No quote data for ${ticker} (${sina.symbol})`);
  }

  const fields = match[1].split(',');
  console.log(`[sina] Raw fields (${fields.length}): ${fields.slice(0, 12).join('|')}`);

  // GBK decode returns BOTH English + Chinese names → all indices shift by 1
  // ASCII:  [name,       open, prevClose, price, high, low, change, change%, ..., volume]
  // GBK:    [name_en, name_cn, open, prevClose, high, low, price, change, change%, ..., volume]
  const hasChineseName = fields.length > 1 && /[^\x00-\x7F]/.test(fields[1] || '');

  if (sina.prefix === 'hk') {
    const off = hasChineseName ? 1 : 0;
    const name = hasChineseName ? (fields[1] || fields[0] || ticker) : (fields[0] || ticker);
    // Validate: force Number(), reject negative/zero prices
    const open = Math.abs(Number(fields[1 + off]) || 0);
    const prevClose = Math.abs(Number(fields[2 + off]) || 0);
    const high = Math.abs(Number(fields[3 + off]) || 0);
    const low = Math.abs(Number(fields[4 + off]) || 0);
    const price = Math.abs(Number(fields[5 + off]) || 0);
    if (price <= 0) throw new Error(`[Sina] Invalid price=0 for ${ticker}`);
    const changeRaw = Number(fields[6 + off]) || 0;
    const changePctRaw = Number(fields[7 + off]) || 0;
    // Sina HK volume is in 手 (lots = 100 shares), convert to actual shares
    const volumeRaw = Math.abs(parseInt(fields[8 + off] || fields[9 + off], 10) || 0);
    const volume = isFinite(volumeRaw) ? volumeRaw * 100 : 0;
    const now = new Date();
    const hktHour = (now.getUTCHours() + 8) % 24;
    const hktMin = now.getUTCMinutes();
    const hktTime = hktHour * 100 + hktMin;
    const inSession = (hktTime >= 930 && hktTime <= 1200) || (hktTime >= 1300 && hktTime <= 1600);

    console.log(`[sina] HK — off=${off} name=${name} open=${open} prev=${prevClose} hi=${high} lo=${low} price=${price} chg=${changeRaw} chg%=${changePctRaw} vol=${volume} ${inSession ? '交易中' : '已收盘'}`);

    return {
      symbol: name, price: round(price), change: round(changeRaw), changePercent: round(changePctRaw),
      dayHigh: round(high), dayLow: round(low), volume, marketTime: Math.floor(Date.now() / 1000),
    };
  }

  if (sina.prefix === 'sh' || sina.prefix === 'sz') {
    const off = hasChineseName ? 1 : 0;
    const name = hasChineseName ? (fields[1] || fields[0] || ticker) : (fields[0] || ticker);
    const open = Math.abs(Number(fields[1 + off]) || 0);
    const prevClose = Math.abs(Number(fields[2 + off]) || 0);
    const price = Math.abs(Number(fields[3 + off]) || 0);
    if (price <= 0) throw new Error(`[Sina] Invalid price=0 for ${ticker}`);
    const high = Math.abs(Number(fields[4 + off]) || 0);
    const low = Math.abs(Number(fields[5 + off]) || 0);
    const volumeRaw = Math.abs(parseInt(fields[8 + off], 10) || 0);
    const volume = isFinite(volumeRaw) ? volumeRaw * 100 : 0; // 手→股
    const change = price - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    console.log(`[sina] A-share — off=${off} name=${name} price=${price} hi=${high} lo=${low}`);

    return {
      symbol: name, price: round(price), change: round(change), changePercent: round(changePct),
      dayHigh: round(high), dayLow: round(low), volume, marketTime: Math.floor(Date.now() / 1000),
    };
  }

  // US: name(0), price(1), change(2), change%(3), ..., high(6), low(7), ..., vol(10)
  const name = fields[0] || ticker;
  const price = parseFloat(fields[1]) || 0;
  return {
    symbol: name, price: round(price),
    change: round(parseFloat(fields[2]) || 0),
    changePercent: round(parseFloat(fields[3]) || 0),
    dayHigh: round(parseFloat(fields[6]) || 0),
    dayLow: round(parseFloat(fields[7]) || 0),
    volume: parseInt(fields[10], 10) || 0,
    marketTime: Math.floor(Date.now() / 1000),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// K-line (daily OHLCV) from Sina Finance
// ═══════════════════════════════════════════════════════════════════════════

const SCALE_MAP: Record<string, string> = {
  '5m': '5', '15m': '15', '30m': '30', '60m': '60', '1h': '60',
  '1d': '240', '1wk': '1200', '1mo': '7200',
};

export async function fetchSinaChart(
  ticker: string, interval: string, range: string,
): Promise<ChartResult> {
  const sina = toSinaSymbol(ticker);
  if (!sina) throw new Error(`[Sina] Cannot map ticker: ${ticker}`);

  const scale = SCALE_MAP[interval] || '240';
  const datalen = range === '5d' ? 1200 : range === '1mo' ? 30 : range === '3mo' ? 90 : range === '6mo' ? 180 : range === '1y' ? 260 : 520;

  const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/'
    + `CN_MarketData.getKLineData?symbol=${sina.symbol}&scale=${scale}&ma=no&datalen=${datalen}`;
  console.log(`[sina] K-line: ${url}`);

  const raw = await fetchSinaJson(url, `kline ${ticker}`);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`[Sina] No kline data for ${ticker}`);
  }

  // Parse: [{day:"2026-05-30",open:"146.000",high:"149.300",low:"144.200",close:"149.900",volume:"4567800"},...]
  const quotes: OHLCVBar[] = [];
  for (const row of raw) {
    const ts = Math.floor(new Date(row.day + 'T00:00:00+08:00').getTime() / 1000);
    quotes.push({
      timestamp: ts,
      open: parseFloat(row.open) || 0,
      high: parseFloat(row.high) || 0,
      low: parseFloat(row.low) || 0,
      close: parseFloat(row.close) || 0,
      volume: parseInt(row.volume, 10) || 0,
    });
  }

  const last = quotes[quotes.length - 1];
  const prevClose = quotes.length > 1 ? quotes[quotes.length - 2].close : last.open;
  console.log(`[sina] K-line OK: ${quotes.length} bars, last close=${last.close}`);

  return {
    meta: {
      symbol: sina.symbol,
      regularMarketPrice: last.close,
      previousClose: prevClose,
      regularMarketTime: last.timestamp,
      exchangeTimezoneName: 'Asia/Shanghai',
    },
    quotes,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
