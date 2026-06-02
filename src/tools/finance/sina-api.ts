// Sina Finance (新浪财经) API — free, no API key, reliable in China.
// Used as cross-verification source alongside East Money.
// Format: http://hq.sinajs.cn/list={prefix}{code}
//   HK: hk09626   A-share: sh600000 / sz000001   US: gb_aapl

import type { QuoteResult } from './eastmoney-api.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Convert QuantAgent ticker format to Sina Finance symbol. */
export function toSinaSymbol(ticker: string): { symbol: string; prefix: string } | null {
  const t = ticker.trim().toUpperCase();

  // Already has known suffix
  if (t.endsWith('.HK')) {
    const code = t.slice(0, -3).replace(/^0+/, ''); // 09626 → 9626
    return { symbol: `hk${code}`, prefix: 'hk' };
  }
  if (t.endsWith('.SS')) {
    return { symbol: `sh${t.slice(0, -3)}`, prefix: 'sh' };
  }
  if (t.endsWith('.SZ')) {
    return { symbol: `sz${t.slice(0, -3)}`, prefix: 'sz' };
  }

  // Numeric tickers
  if (/^\d{4,6}$/.test(t)) {
    if (t.length === 6 && t.startsWith('6')) {
      return { symbol: `sh${t}`, prefix: 'sh' };
    }
    if (t.length === 6 && /^[03]/.test(t)) {
      return { symbol: `sz${t}`, prefix: 'sz' };
    }
    // HK: strip leading zeros
    const hkCode = t.replace(/^0+/, '');
    return { symbol: `hk${hkCode}`, prefix: 'hk' };
  }

  // US tickers (1-5 uppercase letters)
  if (/^[A-Z]{1,5}$/.test(t)) {
    return { symbol: `gb_${t.toLowerCase()}`, prefix: 'gb' };
  }

  return null;
}

export async function fetchSinaQuote(ticker: string): Promise<QuoteResult> {
  const sina = toSinaSymbol(ticker);
  if (!sina) throw new Error(`[Sina] Cannot map ticker: ${ticker}`);

  // Some HK stocks need 5-digit code (09868→hk09868), others need stripped (09626→hk9626)
  let symbols = [sina.symbol];
  if (sina.prefix === 'hk') {
    const code = sina.symbol.slice(2); // hk9868 → 9868
    if (code.length < 5) {
      symbols.push(`hk${code.padStart(5, '0')}`); // also try hk09868
    }
  }

  let text = '';
  let usedSymbol = '';
  for (const sym of symbols) {
    const url = `http://hq.sinajs.cn/list=${sym}`;
    console.log(`[sina] Trying: ${url}`);
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://finance.sina.com.cn/',
          'Accept': '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
        },
        signal: AbortSignal.timeout(10_000),
      });
      text = await resp.text();
      if (text && !text.includes('FAILED') && !text.includes('""')) {
        usedSymbol = sym;
        break;
      }
    } catch (err: any) {
      if (sym === symbols[symbols.length - 1]) throw new Error(`[Sina] Request failed: ${err.message}`);
    }
  }

  if (!text || text.includes('FAILED') || text.includes('""')) {
    throw new Error(`[Sina] No data for ${ticker} (tried: ${symbols.join(', ')})`);
  }
  console.log(`[sina] Success with symbol: ${usedSymbol}`);

  // Parse: var hq_str_hk09626="NAME,OPEN,PREV_CLOSE,PRICE,HIGH,LOW,...,VOLUME,..."
  const match = text.match(/"([^"]*)"/);
  if (!match || !match[1]) {
    throw new Error(`[Sina] Failed to parse: ${text.slice(0, 200)}`);
  }

  const fields = match[1].split(',');
  console.log(`[sina] Raw fields count=${fields.length}: ${fields.slice(0, 10).join(',')}`);

  if (sina.prefix === 'hk') {
    // HK format: name(0), open(1), prevClose(2), price(3), high(4), low(5), ..., volume(8)
    const name = fields[0] || ticker;
    const price = parseFloat(fields[3]) || 0;
    const open = parseFloat(fields[1]) || 0;
    const prevClose = parseFloat(fields[2]) || 0;
    const high = parseFloat(fields[4]) || 0;
    const low = parseFloat(fields[5]) || 0;
    const volume = parseInt(fields[8], 10) || 0;
    const change = price - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    console.log(`[sina] HK quote — name=${name} price=${price.toFixed(2)} change=${change.toFixed(2)} ${changePct.toFixed(2)}%`);

    return {
      symbol: name,
      price: Math.round(price * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round(changePct * 100) / 100,
      dayHigh: Math.round(high * 100) / 100,
      dayLow: Math.round(low * 100) / 100,
      volume,
      marketTime: Math.floor(Date.now() / 1000),
    };
  }

  if (sina.prefix === 'sh' || sina.prefix === 'sz') {
    // A-share format: name(0), open(1), prevClose(2), price(3), high(4), low(5), ..., volume(8)
    const name = fields[0] || ticker;
    const price = parseFloat(fields[3]) || 0;
    const open = parseFloat(fields[1]) || 0;
    const prevClose = parseFloat(fields[2]) || 0;
    const high = parseFloat(fields[4]) || 0;
    const low = parseFloat(fields[5]) || 0;
    const volume = parseInt(fields[8], 10) || 0;
    const change = price - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

    console.log(`[sina] A-share quote — name=${name} price=${price.toFixed(2)}`);

    return {
      symbol: name,
      price: Math.round(price * 100) / 100,
      change: Math.round(change * 100) / 100,
      changePercent: Math.round(changePct * 100) / 100,
      dayHigh: Math.round(high * 100) / 100,
      dayLow: Math.round(low * 100) / 100,
      volume,
      marketTime: Math.floor(Date.now() / 1000),
    };
  }

  // US format
  const name = fields[0] || ticker;
  const price = parseFloat(fields[1]) || 0;
  const change = parseFloat(fields[2]) || 0;
  const changePct = parseFloat(fields[3]) || 0;
  const high = parseFloat(fields[6]) || 0;
  const low = parseFloat(fields[7]) || 0;
  const volume = parseInt(fields[10], 10) || 0;

  console.log(`[sina] US quote — name=${name} price=${price.toFixed(2)}`);

  return {
    symbol: name,
    price: Math.round(price * 100) / 100,
    change: Math.round(change * 100) / 100,
    changePercent: Math.round(changePct * 100) / 100,
    dayHigh: Math.round(high * 100) / 100,
    dayLow: Math.round(low * 100) / 100,
    volume,
    marketTime: Math.floor(Date.now() / 1000),
  };
}
