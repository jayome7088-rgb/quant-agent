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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Rate limiter: max 3 requests per minute, min 1.5s between requests
let lastRequestTime = 0;
let requestsThisMinute = 0;
let minuteStart = Date.now();

async function rateLimit(): Promise<void> {
  const now = Date.now();
  if (now - minuteStart > 60_000) { minuteStart = now; requestsThisMinute = 0; }
  if (requestsThisMinute >= 3) {
    const waitMs = 60_000 - (now - minuteStart) + 1000;
    console.warn(`[eastmoney] Rate limit: waiting ${(waitMs/1000).toFixed(1)}s...`);
    await new Promise(r => setTimeout(r, waitMs));
    minuteStart = Date.now(); requestsThisMinute = 0;
  }
  const sinceLast = now - lastRequestTime;
  if (sinceLast < 1500) await new Promise(r => setTimeout(r, 1500 - sinceLast));
  lastRequestTime = Date.now();
  requestsThisMinute++;
}

async function fetchJson(url: string, label: string, retries = 1): Promise<any> {
  // Try Bun fetch first, fallback to curl on repeated socket failures
  let socketFails = 0;
  let lastErr = '';

  for (let attempt = 0; attempt <= retries; attempt++) {
    await rateLimit();

    // After 2 socket failures, switch to curl
    if (socketFails >= 2) {
      console.warn(`[eastmoney] ${label}: switching to curl after ${socketFails} fetch failures`);
      try {
        const text = await curlFetch(url);
        const data = JSON.parse(text);
        if (data.rc === 0 && data.data !== null) return data;
        lastErr = `curl: API rc=${data.rc}`;
      } catch (e: any) {
        lastErr = `curl: ${e.message}`;
      }
      continue;
    }

    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://quote.eastmoney.com/',
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await resp.text();

      const data = JSON.parse(text);
      if (data.rc !== 0 || data.data === null) {
        lastErr = `API rc=${data.rc}`;
        console.warn(`[eastmoney] ${label} attempt ${attempt+1}/${retries+1}: ${lastErr}`);
        continue;
      }
      return data;
    } catch (err: any) {
      lastErr = err.message;
      if (lastErr.includes('socket') || lastErr.includes('closed')) {
        socketFails++;
      }
      console.warn(`[eastmoney] ${label} attempt ${attempt+1}/${retries+1}: ${err.message}`);
    }
  }
  throw new Error(`[EastMoney] ${label}: ${lastErr}`);
}

/** Fallback: use system curl with HTTP/1.1 forced. */
async function curlFetch(url: string): Promise<string> {
  const proc = Bun.spawn(['curl', '-s', '--http1.1', '--max-time', '15',
    '-H', `User-Agent: ${UA}`,
    '-H', 'Referer: https://quote.eastmoney.com/',
    '-H', 'Accept: */*',
    url], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`curl exit ${exitCode}: ${stderr.slice(0, 200)}`);
  }
  return stdout;
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
  const { symbol, market, secid } = normalizeTicker(ticker);
  const klt = toKlt(interval);
  const lmt = rangeToLimit(range, interval);
  // NOTE: kline API (push2his) returns prices in correct decimal format
  // for ALL markets. The divisor is ONLY needed for the quote API (push2).
  // Do NOT apply a divisor here — it would shrink A-shares by 100x and
  // HK stocks by 1000x, making prices near-zero and triggering synthetic fallback.

  // Try multiple secid formats × fqt values (rc=102 often means fqt unsupported)
  const fqtValues = [1, 0]; // forward-adjusted, then unadjusted
  const secids = altSecids(secid, market);
  let data: any = null;
  let lastErr = '';
  outer:
  for (const fqt of fqtValues) {
    for (const sid of secids) {
      const url = 'http://push2his.eastmoney.com/api/qt/stock/kline/get'
        + `?secid=${sid}`
        + '&fields1=f1,f2,f3,f4,f5,f6'
        + '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'
        + `&klt=${klt}&fqt=${fqt}&lmt=${lmt}`;
      try {
        data = await fetchJson(url, `chart ${ticker} (${interval}, ${range}) sid=${sid} fqt=${fqt}`);
        break outer;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
  }
  if (!data) throw new Error(lastErr);

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

  // Diagnostic
  console.log(`[eastmoney] kline — secid=${secid} name=${rawName} bars=${quotes.length} first=(${quotes[0]?.timestamp},${quotes[0]?.close}) last=(${last.timestamp},${last.close})`);

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

/** Generate alternative secids to try for HK stocks (with/without leading zero). */
function altSecids(primary: string, market: string): string[] {
  if (market !== 'HK') return [primary];
  // e.g. 116.09626 → also try 116.9626
  const parts = primary.split('.');
  if (parts.length === 2 && parts[1].startsWith('0')) {
    const stripped = parts[1].replace(/^0+/, '') || '0';
    return [primary, `${parts[0]}.${stripped}`];
  }
  return [primary];
}

export async function fetchQuote(ticker: string): Promise<QuoteResult> {
  const { symbol, market, secid } = normalizeTicker(ticker);
  const divisor = market === 'HK' ? 1000 : 100;

  const secids = altSecids(secid, market);
  let data: any = null;
  let lastErr = '';
  for (const sid of secids) {
    const url = 'http://push2.eastmoney.com/api/qt/stock/get'
      + `?secid=${sid}`
      + '&fields=f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f86,f169,f170';
    try {
      data = await fetchJson(url, `quote ${ticker} (${sid})`);
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (sid !== secids[secids.length - 1]) {
        console.warn(`[eastmoney] quote secid ${sid} failed, trying ${secids[secids.length - 1]}...`);
      }
    }
  }
  if (!data) throw new Error(lastErr);
  const d = data.data ?? {};

  // Diagnostic: log raw API values to verify East Money returns correct stock
  console.log(`[eastmoney] quote raw — secid=${secid} market=${market} name=${d.f58} f43=${d.f43} f44=${d.f44} f45=${d.f45} f169=${d.f169} f170=${d.f170} f86=${d.f86}`);

  const price = (d.f43 ?? 0) / divisor;
  const prevClose = price - ((d.f169 ?? 0) / divisor);
  const change = (d.f169 ?? 0) / divisor;
  // f170 change percent: HK returns *100 (e.g. 306 = 3.06%)
  const changePctRaw = d.f170 ?? 0;
  const changePct = market === 'HK' ? changePctRaw / 100 : changePctRaw;
  const high = (d.f44 ?? 0) / divisor;
  const low = (d.f45 ?? 0) / divisor;
  const volume = d.f47 ?? 0;

  // f86 is the quote timestamp (Unix seconds or milliseconds)
  const rawTs = d.f86 ?? 0;
  const marketTime = rawTs > 1e12 ? Math.floor(rawTs / 1000) : rawTs > 0 ? rawTs : Math.floor(Date.now() / 1000);

  console.log(`[eastmoney] quote computed — name=${d.f58} price=${price.toFixed(2)} change=${change.toFixed(2)} ${changePct.toFixed(2)}% hi=${high.toFixed(2)} lo=${low.toFixed(2)} vol=${volume}`);

  return {
    symbol: d.f58 ?? symbol,
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePct * 100) / 100,
    dayHigh: Math.round(high * 100) / 100,
    dayLow: Math.round(low * 100) / 100,
    volume,
    marketTime,
  };
}
