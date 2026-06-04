// AKShare bridge — calls Python subprocess for HK daily kline data.
// Replaces Sina Finance kline API which has been shut down.
// Keep sina-api.ts for real-time quotes only.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { OHLCVBar, ChartResult } from './eastmoney-api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FETCHER_PATH = join(__dirname, 'akshare_fetcher.py');

function findPython(): string {
  const candidates = [
    'python', 'python3', process.env.PYTHON_PATH,
    ...(process.platform === 'win32'
      ? ['C:\\Users\\jc\\AppData\\Local\\Programs\\Python\\Python312\\python.exe', 'C:\\Python312\\python.exe']
      : ['/usr/bin/python3', '/usr/local/bin/python3']),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const proc = Bun.spawnSync([c, '--version'], { stdout: 'pipe', stderr: 'pipe' });
      if (proc.exitCode === 0) return c;
    } catch { /* continue */ }
  }
  throw new Error('Python not found.');
}

/**
 * Fetch HK stock daily OHLCV data via AKShare.
 * ticker: "09868.HK", "00700.HK", etc.
 * range: "1y", "2y", "5y" → maps to start_date
 */
export async function fetchAKShareChart(
  ticker: string,
  interval: string,
  range: string,
): Promise<ChartResult> {
  // Only daily data is supported for now (AKShare has intraday via a different API)
  if (interval !== '1d') {
    throw new Error('AKShare kline only supports 1d interval. Use synthetic for intraday.');
  }

  // Map range to start_date
  const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const years = range === '5y' ? 5 : range === '2y' ? 2 : range === '1y' ? 1 : 1;
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - years);
  const startStr = startDate.toISOString().slice(0, 10).replace(/-/g, '');

  console.log(`[akshare] Fetching ${ticker} from ${startStr} to ${endDate}...`);

  const python = findPython();
  const input = JSON.stringify({ ticker, start_date: startStr, end_date: endDate });
  const proc = Bun.spawn([python, FETCHER_PATH], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(new TextEncoder().encode(input));
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 45_000);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) throw new Error('AKShare request timed out (45s)');
  if (exitCode !== 0) {
    const errMsg = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
    throw new Error(`AKShare fetch failed: ${errMsg}`);
  }

  let parsed: { quotes?: OHLCVBar[]; count?: number; error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`AKShare returned invalid JSON: ${stdout.slice(0, 300)}`);
  }

  if (parsed.error) throw new Error(`AKShare: ${parsed.error}`);

  const quotes = parsed.quotes || [];
  if (quotes.length === 0) throw new Error(`AKShare returned no data for ${ticker}`);

  const last = quotes[quotes.length - 1];
  console.log(`[akshare] ${ticker}: ${quotes.length} bars, last close=${last.close}`);

  return {
    meta: {
      symbol: ticker,
      regularMarketPrice: last.close,
      previousClose: quotes.length > 1 ? quotes[quotes.length - 2].close : last.open,
      regularMarketTime: last.timestamp,
      exchangeTimezoneName: 'Asia/Shanghai',
    },
    quotes,
  };
}
