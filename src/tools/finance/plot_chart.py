"""
QuantAgent chart generator — reads JSON from stdin, outputs base64 PNG to stdout.
Supports: equity_curve, indicator_overlay, feature_importance,
          feature_importance_bar, candlestick, backtest_metrics_table.

CRITICAL: matplotlib.use('Agg') MUST be set BEFORE importing pyplot.
          Do NOT call plt.show() — it clears the figure buffer.
          Always call plt.close('all') after saving to free memory.
"""
import sys, json, base64, io, os, traceback
from datetime import datetime

# ═══════════════════════════════════════════════════════════════════════════
# Dependency checks — must happen before any matplotlib import
# ═══════════════════════════════════════════════════════════════════════════

MISSING_DEPS = []

try:
    import numpy as np
except ImportError as e:
    MISSING_DEPS.append(f"numpy: {e}")

try:
    import matplotlib
    matplotlib.use('Agg')  # ← MUST come before pyplot import
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
except ImportError as e:
    MISSING_DEPS.append(f"matplotlib: {e}")

try:
    import seaborn as sns
    _HAS_SEABORN = True
except ImportError:
    _HAS_SEABORN = False

# ═══════════════════════════════════════════════════════════════════════════
# Style setup (only if matplotlib loaded)
# ═══════════════════════════════════════════════════════════════════════════

if 'matplotlib' not in [d.split(':')[0] for d in MISSING_DEPS]:
    if _HAS_SEABORN:
        sns.set_style("darkgrid")
        sns.set_palette("muted")
    else:
        plt.style.use('dark_background')

    plt.rcParams.update({
        'figure.facecolor': '#0d1117',
        'axes.facecolor': '#161b22',
        'axes.edgecolor': '#30363d',
        'axes.labelcolor': '#c9d1d9',
        'text.color': '#c9d1d9',
        'xtick.color': '#8b949e',
        'ytick.color': '#8b949e',
        'grid.color': '#21262d',
        'figure.dpi': 100,
        'savefig.bbox': 'tight',
        'savefig.pad_inches': 0.1,
    })

FONT_FAMILY = 'monospace'


def fig_to_b64(fig):
    """Convert matplotlib figure to base64 PNG string. Closes the figure after."""
    buf = io.BytesIO()
    try:
        fig.savefig(buf, format='png', dpi=100, bbox_inches='tight', pad_inches=0.2)
        buf.seek(0)
        img_bytes = buf.read()
        b64 = base64.b64encode(img_bytes).decode('utf-8')
        print(f"[plot_chart] Generated {len(img_bytes)} bytes → {len(b64)} chars base64", file=sys.stderr)
        return b64
    finally:
        plt.close(fig)  # explicit close to free memory


# ═══════════════════════════════════════════════════════════════════════════
# Chart functions
# ═══════════════════════════════════════════════════════════════════════════

def plot_equity_curve(data, title):
    """data: { equity: number[] }"""
    equity = data.get('equity', [])
    if not equity:
        raise ValueError('equity_curve requires "equity" array')

    print(f"[plot_chart] equity_curve: {len(equity)} data points, start={equity[0]:.2f}, end={equity[-1]:.2f}", file=sys.stderr)

    fig, ax = plt.subplots(figsize=(8, 3.5))
    x = list(range(len(equity)))
    ax.plot(x, equity, color='#58a6ff', linewidth=1.2)
    ax.fill_between(x, equity, equity[0], alpha=0.15, color='#58a6ff')
    ax.axhline(y=equity[0], color='#8b949e', linestyle='--', linewidth=0.6, alpha=0.5)

    final = equity[-1]
    ax.annotate(f'{final:,.0f}', xy=(len(equity)-1, final),
                xytext=(6, 0), textcoords='offset points',
                color='#c9d1d9', fontsize=9, va='center',
                fontfamily=FONT_FAMILY)

    ax.set_title(title or 'Equity Curve', color='#58a6ff', fontsize=12, fontweight='bold',
                 fontfamily=FONT_FAMILY)
    ax.set_ylabel('Equity', fontfamily=FONT_FAMILY)
    ax.set_xlabel('Trade #', fontfamily=FONT_FAMILY)
    ax.tick_params(labelsize=8)
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v:,.0f}'))
    fig.tight_layout()

    result = fig_to_b64(fig)
    print(f"[plot_chart] equity_curve: SUCCESS", file=sys.stderr)
    return result


def plot_indicator_overlay(data, title):
    """data: { closes: number[], sma20?: number[], sma60?: number[], volume?: number[] }"""
    dates_raw = data.get('dates', [])
    closes = data.get('closes', [])
    sma20 = data.get('sma20', [])
    sma60 = data.get('sma60', [])
    volume = data.get('volume', [])

    if not closes:
        raise ValueError('indicator_overlay requires "closes" array')

    try:
        dates = [datetime.fromisoformat(d.replace('Z', '+00:00')) if isinstance(d, str)
                 else datetime.fromtimestamp(d) for d in dates_raw]
    except:
        dates = list(range(len(closes)))

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 5),
                                    gridspec_kw={'height_ratios': [3, 1]}, sharex=True)

    ax1.plot(dates, closes, color='#c9d1d9', linewidth=0.8, label='Close')
    if sma20 and len(sma20) == len(closes):
        ax1.plot(dates, sma20, color='#58a6ff', linewidth=0.7, alpha=0.8, label='SMA20')
    if sma60 and len(sma60) == len(closes):
        ax1.plot(dates, sma60, color='#d2991d', linewidth=0.7, alpha=0.8, label='SMA60')

    ax1.set_title(title or 'Price & Indicators', color='#58a6ff', fontsize=12, fontweight='bold',
                  fontfamily=FONT_FAMILY)
    ax1.legend(loc='upper left', fontsize=8, framealpha=0.3, edgecolor='#30363d')
    ax1.tick_params(labelsize=8)

    if volume and len(volume) == len(closes):
        colors = ['#3fb950' if closes[i] >= closes[i-1] else '#f85149' for i in range(1, len(closes))]
        colors.insert(0, '#3fb950')
        ax2.bar(dates, volume, color=colors, alpha=0.5, width=0.8)
        ax2.set_ylabel('Volume', fontsize=9, fontfamily=FONT_FAMILY)
        ax2.tick_params(labelsize=8)
        ax2.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v/1e6:.0f}M' if v >= 1e6 else f'{v/1e3:.0f}K'))

    if dates and isinstance(dates[0], datetime):
        ax2.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d'))
        fig.autofmt_xdate()

    fig.tight_layout()
    return fig_to_b64(fig)


def plot_feature_importance(data, title):
    """data: { features: string[], importance: number[] }"""
    features = data.get('features', [])
    importance = data.get('importance', [])

    if not features or not importance:
        raise ValueError('feature_importance requires "features" and "importance" arrays')

    pairs = sorted(zip(features, importance), key=lambda x: abs(x[1]), reverse=True)[:15]
    pairs.reverse()

    labels = [p[0] for p in pairs]
    values = [p[1] for p in pairs]

    fig, ax = plt.subplots(figsize=(7, 4))
    colors = ['#3fb950' if v >= 0 else '#f85149' for v in values]
    bars = ax.barh(labels, values, color=colors, height=0.6)

    for bar, val in zip(bars, values):
        sign = '+' if val >= 0 else ''
        ax.text(val, bar.get_y() + bar.get_height()/2,
                f' {sign}{val:.2f}%', va='center', fontsize=8,
                color='#c9d1d9', fontfamily=FONT_FAMILY)

    ax.axvline(x=0, color='#8b949e', linewidth=0.5)
    ax.set_title(title or 'Feature Importance', color='#58a6ff', fontsize=12, fontweight='bold',
                 fontfamily=FONT_FAMILY)
    ax.tick_params(labelsize=8)
    fig.tight_layout()
    return fig_to_b64(fig)


def plot_candlestick(data, title):
    """data: { ohlcv: [{o,h,l,c,v,ts},...] }"""
    ohlcv = data.get('ohlcv', [])
    if not ohlcv:
        raise ValueError('candlestick requires "ohlcv" array')

    try:
        import mplfinance as mpf
    except ImportError:
        return _plot_candlestick_fallback(ohlcv, title)

    import pandas as pd
    rows = []
    for bar in ohlcv:
        ts = bar.get('ts', bar.get('timestamp', 0))
        try:
            dt = datetime.fromtimestamp(ts) if isinstance(ts, (int, float)) and ts > 1e9 \
                else datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
        except:
            dt = datetime.now()
        rows.append({
            'Date': dt,
            'Open': bar.get('o', bar.get('open', 0)),
            'High': bar.get('h', bar.get('high', 0)),
            'Low': bar.get('l', bar.get('low', 0)),
            'Close': bar.get('c', bar.get('close', 0)),
            'Volume': bar.get('v', bar.get('volume', 0)),
        })

    df = pd.DataFrame(rows)
    df.set_index('Date', inplace=True)

    mc = mpf.make_marketcolors(up='#3fb950', down='#f85149',
                                edge='inherit', wick='inherit',
                                volume={'up': '#3fb95033', 'down': '#f8514933'})
    style = mpf.make_mpf_style(base_mpf_style='nightclouds', marketcolors=mc,
                                facecolor='#0d1117', gridcolor='#21262d')

    fig, _ = mpf.plot(df, type='candle', style=style, volume=True,
                      title=title or 'Candlestick Chart',
                      figsize=(8, 4.5), returnfig=True,
                      ylabel='Price', ylabel_lower='Volume')
    return fig_to_b64(fig)


def _plot_candlestick_fallback(ohlcv, title):
    closes = [b.get('c', b.get('close', 0)) for b in ohlcv]
    volumes = [b.get('v', b.get('volume', 0)) for b in ohlcv]
    x = list(range(len(closes)))

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(8, 4.5),
                                    gridspec_kw={'height_ratios': [3, 1]}, sharex=True)
    ax1.plot(x, closes, color='#58a6ff', linewidth=1.2)
    ax1.fill_between(x, closes, closes[0], alpha=0.15, color='#58a6ff')
    ax1.set_title(title or 'Price Chart', color='#58a6ff', fontsize=12, fontweight='bold',
                  fontfamily=FONT_FAMILY)
    ax1.tick_params(labelsize=8)

    if volumes:
        colors = ['#3fb950' if closes[i] >= closes[i-1] else '#f85149' for i in range(1, len(closes))]
        colors.insert(0, '#3fb950')
        ax2.bar(x, volumes, color=colors, alpha=0.5, width=0.8)
        ax2.set_ylabel('Volume', fontsize=9, fontfamily=FONT_FAMILY)
        ax2.tick_params(labelsize=8)
        ax2.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f'{v/1e6:.0f}M' if v >= 1e6 else f'{v/1e3:.0f}K'))

    fig.tight_layout()
    return fig_to_b64(fig)


def plot_backtest_metrics_table(data, title):
    """data: { labels: string[], values: string[] }"""
    labels = data.get('labels', [])
    values = data.get('values', [])

    if not labels or not values:
        raise ValueError('backtest_metrics_table requires "labels" and "values" arrays')

    n = len(labels)
    fig, ax = plt.subplots(figsize=(5.5, 0.4 * n + 1.2))
    ax.axis('off')
    ax.set_title(title or 'Backtest Metrics', color='#58a6ff', fontsize=12, fontweight='bold',
                 fontfamily=FONT_FAMILY, pad=12)

    cell_text = [[labels[i], values[i]] for i in range(n)]
    col_colors = ['#161b22', '#0d1117']

    table = ax.table(
        cellText=cell_text,
        colLabels=['指标', '数值'],
        cellLoc='left', loc='center',
        cellColours=[[col_colors[j % 2]] * 2 for j in range(n)],
        colColours=[col_colors[0]] * 2,
    )

    table.auto_set_font_size(False)
    table.set_fontsize(10)
    table.scale(1.0, 1.4)

    for key, cell in table.get_celld().items():
        cell.set_edgecolor('#30363d')
        cell.set_text_props(color='#c9d1d9', fontfamily=FONT_FAMILY)
        if key[0] == 0:
            cell.set_text_props(color='#58a6ff', fontweight='bold', fontfamily=FONT_FAMILY)
            cell.set_facecolor('#0d1117')

    fig.tight_layout()
    return fig_to_b64(fig)


CHART_TYPES = {
    'equity_curve': plot_equity_curve,
    'indicator_overlay': plot_indicator_overlay,
    'feature_importance': plot_feature_importance,
    'feature_importance_bar': plot_feature_importance,
    'candlestick': plot_candlestick,
    'backtest_metrics_table': plot_backtest_metrics_table,
}

# ═══════════════════════════════════════════════════════════════════════════
# Main entry point
# ═══════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    try:
        raw = sys.stdin.read()
        print(f"[plot_chart] Received {len(raw)} bytes from stdin", file=sys.stderr)
        params = json.loads(raw)
    except Exception as e:
        print(json.dumps({'error': f'Failed to parse input: {e}'}))
        sys.exit(1)

    chart_type = params.get('chart_type', '')
    print(f"[plot_chart] Requested chart_type={chart_type}", file=sys.stderr)

    if MISSING_DEPS:
        err = f'Missing Python packages: {"; ".join(MISSING_DEPS)}. Install: pip install matplotlib seaborn numpy'
        print(f"[plot_chart] ERROR: {err}", file=sys.stderr)
        print(json.dumps({'error': err}))
        sys.exit(1)

    handler = CHART_TYPES.get(chart_type)
    if not handler:
        err = f'Unknown chart_type: {chart_type}. Available: {list(CHART_TYPES.keys())}'
        print(f"[plot_chart] ERROR: {err}", file=sys.stderr)
        print(json.dumps({'error': err}))
        sys.exit(1)

    try:
        b64 = handler(params.get('data', {}), params.get('title', ''))
        print(json.dumps({'base64': b64, 'chart_type': chart_type}))
        print(f"[plot_chart] DONE: {chart_type}", file=sys.stderr)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
