// Plot bridge — calls Python subprocess to generate seaborn/matplotlib charts,
// returns base64-encoded PNG strings. Mirrors the xgb-bridge.ts pattern.
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLOTTER_PATH = join(__dirname, 'plot_chart.py');

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
      // not found, continue
    }
  }
  throw new Error('Python not found. Install Python 3.12+ from https://python.org.');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChartType = 'equity_curve' | 'indicator_overlay' | 'feature_importance' | 'candlestick';

export interface PlotRequest {
  chart_type: ChartType;
  data: Record<string, unknown>;
  title?: string;
}

export interface PlotResult {
  base64: string;
  chart_type: ChartType;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateChart(
  chartType: ChartType,
  data: Record<string, unknown>,
  title?: string,
): Promise<PlotResult> {
  const python = findPython();
  const input = JSON.stringify({ chart_type: chartType, data, title: title || '' });
  const proc = Bun.spawn([python, PLOTTER_PATH], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  proc.stdin.write(new TextEncoder().encode(input));
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, 30_000);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (timedOut) {
    throw new Error('Chart generation timed out after 30s');
  }

  if (exitCode !== 0) {
    const errMsg = stderr.trim() || stdout.trim() || `Python exited with code ${exitCode}`;
    throw new Error(`Chart generation failed: ${errMsg}`);
  }

  let parsed: { base64?: string; chart_type?: string; error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Chart generator returned invalid JSON: ${stdout.slice(0, 300)}`);
  }

  if (parsed.error) {
    throw new Error(`Chart error: ${parsed.error}`);
  }

  if (!parsed.base64) {
    throw new Error('Chart generator returned no base64 data');
  }

  return { base64: parsed.base64, chart_type: (parsed.chart_type || chartType) as ChartType };
}

const PLACEHOLDER_RE = /\{\{PLOT:\w+\}\}/g;

/** Strip all plot placeholders from text — used as fallback when charts unavailable. */
export function stripPlotPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_RE, '');
}

/**
 * Batch generate multiple charts from plot placeholders in formatted text.
 * Never throws — always returns clean text, with or without charts.
 */
export async function resolvePlotPlaceholders(
  formatted: string,
  plotData: Record<string, { data: Record<string, unknown>; title?: string }>,
): Promise<{ text: string; plots: Map<string, string> }> {
  const plots = new Map<string, string>();
  let text = formatted;

  const matches = [...formatted.matchAll(PLACEHOLDER_RE)];

  // Quick check: can we even run Python?
  let pythonAvailable = true;
  try { findPython(); } catch { pythonAvailable = false; }

  if (!pythonAvailable) {
    return { text: stripPlotPlaceholders(formatted), plots };
  }

  for (const match of matches) {
    const chartType = match[1] as ChartType;
    const config = plotData[chartType];

    if (!config) {
      text = text.replace(match[0], '');
      continue;
    }

    try {
      const result = await generateChart(chartType, config.data, config.title);
      const dataUrl = `data:image/png;base64,${result.base64}`;
      plots.set(chartType, dataUrl);
      text = text.replace(match[0], `[图表: ${chartType}]`);
    } catch {
      text = text.replace(match[0], `[图表: ${chartType} — 生成失败]`);
    }
  }

  return { text, plots };
}
