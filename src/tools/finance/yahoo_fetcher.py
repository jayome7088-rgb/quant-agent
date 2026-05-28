"""Yahoo Finance data fetcher using yfinance library. Outputs JSON to stdout."""
import sys
import json
import yfinance as yf
from datetime import datetime


def fetch_chart(symbol, interval, period):
    """Fetch OHLCV chart data."""
    ticker = yf.Ticker(symbol)
    # Map our interval/range to yfinance params
    df = ticker.history(interval=interval, period=period, prepost=False)
    if df.empty:
        print(json.dumps({"error": f"No data for {symbol}"}))
        sys.exit(1)

    quotes = []
    for idx, row in df.iterrows():
        ts = int(idx.timestamp())
        quotes.append({
            "timestamp": ts,
            "open": round(float(row["Open"]), 4),
            "high": round(float(row["High"]), 4),
            "low": round(float(row["Low"]), 4),
            "close": round(float(row["Close"]), 4),
            "volume": int(row["Volume"]),
        })

    info = ticker.info or {}
    result = {
        "meta": {
            "symbol": symbol,
            "regularMarketPrice": round(float(quotes[-1]["close"]), 4) if quotes else 0,
            "previousClose": round(float(info.get("previousClose", 0)), 4),
            "regularMarketTime": quotes[-1]["timestamp"] if quotes else 0,
            "exchangeTimezoneName": info.get("exchangeTimezoneName", "UTC"),
        },
        "quotes": quotes,
    }
    print(json.dumps(result))


def fetch_quote(symbol):
    """Fetch current quote snapshot."""
    ticker = yf.Ticker(symbol)
    info = ticker.info or {}
    price = info.get("currentPrice") or info.get("regularMarketPrice") or 0
    prev = info.get("previousClose") or 0
    change = price - prev if price and prev else 0
    change_pct = (change / prev * 100) if prev else 0

    result = {
        "symbol": symbol,
        "price": round(float(price), 4),
        "change": round(float(change), 4),
        "changePercent": round(float(change_pct), 4),
        "dayHigh": round(float(info.get("dayHigh") or 0), 4),
        "dayLow": round(float(info.get("dayLow") or 0), 4),
        "volume": info.get("volume") or 0,
        "marketTime": int(datetime.now().timestamp()),
    }
    print(json.dumps(result))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: yahoo_fetcher.py chart|quote symbol [interval] [period]"}))
        sys.exit(1)

    cmd = sys.argv[1]
    try:
        if cmd == "chart":
            symbol = sys.argv[2]
            interval = sys.argv[3] if len(sys.argv) > 3 else "5m"
            period = sys.argv[4] if len(sys.argv) > 4 else "5d"
            fetch_chart(symbol, interval, period)
        elif cmd == "quote":
            symbol = sys.argv[2]
            fetch_quote(symbol)
        else:
            print(json.dumps({"error": f"Unknown command: {cmd}"}))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
