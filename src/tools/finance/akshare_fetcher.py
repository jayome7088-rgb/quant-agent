"""
AKShare HK daily data fetcher — replaces closed Sina Finance kline API.
Reads stock code from stdin JSON, outputs OHLCV bars to stdout JSON.

Usage: echo '{"ticker":"09868","start_date":"20210101","end_date":"20260604"}' | python akshare_fetcher.py
"""
import sys, json

try:
    import akshare as ak
except ImportError:
    print(json.dumps({"error": "akshare not installed. Run: pip install akshare -U"}))
    sys.exit(1)


def fetch_hk_daily(ticker: str, start_date: str, end_date: str):
    """Fetch HK stock daily OHLCV via AKShare stock_hk_daily."""
    # Convert ticker: 09868.HK → 09868 (AKShare uses numeric code)
    code = ticker.replace('.HK', '').replace('.SS', '').replace('.SZ', '')

    try:
        df = ak.stock_hk_daily(symbol=code, adjust="qfq")
    except Exception as e:
        raise RuntimeError(f"AKShare stock_hk_daily({code}) failed: {e}")

    if df is None or df.empty:
        raise RuntimeError(f"AKShare returned empty data for {code}")

    # AKShare returns datetime.date objects — convert filter strings to date
    from datetime import datetime
    start_dt = datetime.strptime(start_date, '%Y%m%d').date()
    end_dt = datetime.strptime(end_date, '%Y%m%d').date()
    # Convert df date column to date objects if they're strings
    if df['date'].dtype == 'object':
        df['date'] = pd.to_datetime(df['date']).dt.date
    df = df[(df['date'] >= start_dt) & (df['date'] <= end_dt)]

    bars = []
    for _, row in df.iterrows():
        ts = int(pd.Timestamp(row['date']).timestamp())
        bars.append({
            "timestamp": ts,
            "open": float(row['open']),
            "high": float(row['high']),
            "low": float(row['low']),
            "close": float(row['close']),
            "volume": int(row['volume']),
        })

    return bars

# Need pandas for AKShare
import pandas as pd


if __name__ == '__main__':
    raw = sys.stdin.read()
    try:
        params = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {e}"}))
        sys.exit(1)

    ticker = params.get("ticker", "")
    start_date = params.get("start_date", "20210101")
    end_date = params.get("end_date", "20260604")

    try:
        bars = fetch_hk_daily(ticker, start_date, end_date)
        print(json.dumps({"quotes": bars, "count": len(bars)}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
