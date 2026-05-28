// Yahoo Finance API client — uses Python yfinance library for reliable data access.
// yfinance handles cookie/crumb session management that raw HTTP cannot from sandbox IPs.

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FETCHER_PATH = join(__dirname, 'yahoo_fetcher.py');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OHLCVBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface YahooChartResult {
  meta: {
    symbol: string;
    regularMarketPrice: number;
    previousClose: number;
    regularMarketTime: number;
    exchangeTimezoneName: string;
  };
  quotes: OHLCVBar[];
}

export interface YahooQuoteResult {
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
// Ticker normalization
// ---------------------------------------------------------------------------

export function normalizeTicker(raw: string): { symbol: string; market: string } {
  const trimmed = raw.trim().toUpperCase();

  // Already has a known suffix — pass through
  if (/\.(HK|SS|SZ|T|L|PA|V|TO|AX|SI|KS|KQ)$/.test(trimmed)) {
    const market = trimmed.split('.').pop()!;
    return { symbol: trimmed, market };
  }

  // US: 1-5 uppercase letters
  if (/^[A-Z]{1,5}$/.test(trimmed) || /^[A-Z]{1,5}[-.][AB]$/.test(trimmed)) {
    return { symbol: trimmed, market: 'US' };
  }

  // Numeric tickers
  if (/^\d{4,6}$/.test(trimmed)) {
    if (trimmed.length === 6 && trimmed.startsWith('6')) {
      return { symbol: `${trimmed}.SS`, market: 'SS' };
    }
    if (trimmed.length === 6 && /^[03]/.test(trimmed)) {
      return { symbol: `${trimmed}.SZ`, market: 'SZ' };
    }
    const stripped = trimmed.replace(/^0+/, '');
    return { symbol: `${stripped}.HK`, market: 'HK' };
  }

  return { symbol: trimmed, market: 'unknown' };
}

// ---------------------------------------------------------------------------
// Python bridge
// ---------------------------------------------------------------------------

function findPython(): string {
  const candidates = [
    'python',
    'python3',
    process.env.PYTHON_PATH,
    ...(process.platform === 'win32'
      ? [
          'C:\\Users\\jc\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
          'C:\\Python312\\python.exe',
        ]
      : ['/usr/bin/python3', '/usr/local/bin/python3']),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      const proc = Bun.spawnSync([c, '--version'], { stdout: 'pipe', stderr: 'pipe' });
      if (proc.exitCode === 0) return c;
    } catch {
      // continue
    }
  }
  throw new Error('Python not found. Install Python 3.12+ and yfinance (pip install yfinance).');
}

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:7890';

async function callPython(args: string[], label: string, timeoutMs = 30_000): Promise<any> {
  const python = findPython();
  const proc = Bun.spawn([python, FETCHER_PATH, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      HTTPS_PROXY: PROXY_URL,
      HTTP_PROXY: PROXY_URL,
    },
  });
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    throw new Error(`[Yahoo Finance] ${label} timed out after ${timeoutMs / 1000}s (Yahoo Finance may be unreachable)`);
  }

  if (exitCode !== 0) {
    throw new Error(`[Yahoo Finance] ${label} failed: ${stderr.trim() || `exit ${exitCode}`}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`[Yahoo Finance] ${label} invalid JSON: ${output.slice(0, 300)}`);
  }

  if (parsed.error) {
    throw new Error(`[Yahoo Finance] ${label}: ${parsed.error}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchYahooChart(
  symbol: string,
  interval: string,
  range: string,
): Promise<YahooChartResult> {
  const data = await callPython(
    ['chart', symbol, interval, range],
    `chart ${symbol} (${interval}, ${range})`,
  );
  return data as YahooChartResult;
}

export async function fetchYahooQuote(symbol: string): Promise<YahooQuoteResult> {
  const data = await callPython(['quote', symbol], `quote ${symbol}`);
  return data as YahooQuoteResult;
}
