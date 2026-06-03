// QuantAgent Web Server — Bun.serve + SSE (pure), zero extra dependencies.
import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_HTML = join(__dirname, 'client.html');

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

class SSEController {
  private closed = false;
  constructor(private controller: ReadableStreamDefaultController) {}

  send(event: string, data: string): boolean {
    if (this.closed) return false;
    try {
      this.controller.enqueue(new TextEncoder().encode(sseEvent(event, data)));
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.controller.close(); } catch { /* ok */ }
  }
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleAnalyzeSSE(url: URL): Promise<Response> {
  const ticker = url.searchParams.get('ticker');
  const interval = (url.searchParams.get('interval') || '5m') as '1m' | '5m' | '15m' | '30m' | '1h';

  if (!ticker) {
    return new Response('Missing ticker parameter', { status: 400 });
  }

  console.log(`[server] SSE analyze starting for ${ticker} (${interval})`);

  const stream = new ReadableStream({
    async start(controller) {
      const sse = new SSEController(controller);

      // SSE heartbeat: send ping comment every 15s to prevent proxy/OS close
      const heartbeat = setInterval(() => {
        try { controller.enqueue(new TextEncoder().encode(': ping\n\n')); } catch { /* closed */ }
      }, 15_000);

      try {
        const { createStockAnalyzer } = await import('../tools/finance/stock-analyzer.js');
        const tool = createStockAnalyzer();

        sse.send('progress', JSON.stringify({ stage: 'starting', message: `开始分析 ${ticker}…` }));
        console.log(`[server] SSE sent: progress/starting`);

        const result = await tool.invoke(
          { ticker, interval },
          {
            metadata: {
              onProgress: (msg: string) => {
                sse.send('progress', JSON.stringify({ stage: 'running', message: msg }));
                console.log(`[server] SSE sent: progress/${msg.slice(0, 40)}`);
              },
            },
          },
        );

        // Parse tool result
        let text = String(result);
        let plots: Record<string, string> = {};
        try {
          const parsed = JSON.parse(text);
          if (parsed.data) {
            if (typeof parsed.data === 'string') {
              text = parsed.data;
            } else {
              text = String(parsed.data.data || '');
              plots = parsed.data.plots || {};
            }
          }
        } catch { /* plain text */ }

        console.log(`[server] Tool completed. Plots: ${Object.keys(plots).length} [${Object.keys(plots).join(', ')}]`);

        // Send each chart as its own named SSE event
        for (const [chartType, dataUrl] of Object.entries(plots)) {
          if (typeof dataUrl === 'string' && dataUrl.length > 100) {
            console.log(`[server] SSE sending event: ${chartType}, data_url: ${dataUrl.slice(0, 50)}... (${dataUrl.length} chars)`);
            sse.send(chartType, dataUrl);
          } else {
            console.log(`[server] SSE SKIP ${chartType}: bad data_url (len=${dataUrl?.length ?? 0})`);
          }
        }

        // Send text result
        sse.send('result', text);
        sse.send('done', JSON.stringify({ ticker, interval }));

        // Save to history
        try {
          const { insertAnalysis } = await import('./history-db.js');
          insertAnalysis(ticker, interval, text);
        } catch { /* non-fatal */ }

        console.log(`[server] SSE analyze complete for ${ticker}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[server] SSE analyze error: ${msg}`);
        sse.send('error', msg);
      } finally {
        clearInterval(heartbeat);
        sse.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function handleChat(req: Request): Promise<Response> {
  let body: { query?: string; apiKey?: string; provider?: string } = {};
  try { body = await req.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { query, apiKey, provider } = body;
  if (!query?.trim()) return jsonResponse({ error: 'Missing query' }, 400);
  if (!apiKey?.trim()) return jsonResponse({ error: '请提供你的 API Key（在聊天框下方输入）' }, 400);

  const prov = provider || 'deepseek';
  const { Providers } = await import('../model/providers.js');
  const cfg = Providers[prov.toLowerCase()];
  if (!cfg) return jsonResponse({ error: `Unknown provider: ${prov}` }, 400);

  const keyEnv = cfg.apiKeyEnv;
  const prevKey = process.env[keyEnv] || '';
  process.env[keyEnv] = apiKey;

  console.log(`[server] SSE chat starting with ${prov}, query: "${query.slice(0, 60)}..."`);

  const stream = new ReadableStream({
    async start(controller) {
      const sse = new SSEController(controller);
      try {
        const { Agent } = await import('../agent/agent.js');
        const agent = await Agent.create({
          model: `${prov}:${cfg.defaultModel}`,
          memoryEnabled: false,
          usePlanner: false,
        });

        for await (const event of agent.run(query.trim())) {
          if (event.type === 'stream_progress') {
            const se = event as { text?: string; mode: string };
            if (se.text) sse.send('token', JSON.stringify({ text: se.text, mode: se.mode }));
          } else if (event.type === 'thinking') {
            sse.send('thinking', JSON.stringify({ text: (event as { message: string }).message }));
          } else if (event.type === 'tool_start') {
            const te = event as { tool: string; args: Record<string, unknown> };
            sse.send('tool_start', JSON.stringify({ tool: te.tool, args: te.args }));
          } else if (event.type === 'tool_end') {
            const te = event as { tool: string; result: string };
            sse.send('tool_end', JSON.stringify({ tool: te.tool, result: te.result.slice(0, 2000) }));
          } else if (event.type === 'tool_error') {
            const te = event as { tool: string; error: string };
            sse.send('tool_error', JSON.stringify({ tool: te.tool, error: te.error }));
          } else if (event.type === 'done') {
            const de = event as { answer: string; iterations: number; totalTime: number };
            sse.send('done', JSON.stringify({ answer: de.answer, iterations: de.iterations, totalTime: de.totalTime }));
          }
        }
      } catch (err) {
        sse.send('error', JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
      } finally {
        if (keyEnv) process.env[keyEnv] = prevKey;
        sse.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    },
  });
}

async function handleHistory(req: Request, url: URL): Promise<Response> {
  const { listAnalyses, getAnalysis, deleteAnalysis } = await import('./history-db.js');

  const idMatch = url.pathname.match(/^\/api\/history\/(\d+)$/);
  if (idMatch) {
    const id = parseInt(idMatch[1], 10);
    if (req.method === 'GET') {
      const entry = getAnalysis(id);
      return entry ? jsonResponse(entry) : jsonResponse({ error: 'Not found' }, 404);
    }
    if (req.method === 'DELETE') {
      deleteAnalysis(id);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  if (req.method === 'GET') {
    const search = url.searchParams.get('search') || undefined;
    const sort = (url.searchParams.get('sort') || 'desc') as 'asc' | 'desc';
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    return jsonResponse(listAnalyses({ search, sort, limit, offset }));
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

async function handleChartAPI(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonResponse({ error: 'Use POST with JSON body' }, 405);

  let body: { chart_type?: string; data?: Record<string, unknown>; title?: string };
  try { body = await req.json(); } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { chart_type, data, title } = body;
  if (!chart_type || !data) return jsonResponse({ error: 'Missing chart_type or data' }, 400);

  try {
    const { generateChart } = await import('../tools/finance/plot-bridge.js');
    const result = await generateChart(chart_type as any, data as any, title);
    return jsonResponse({ chart_type: result.chart_type, data_url: `data:image/png;base64,${result.base64}` });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
}

async function handleStrategy(req: Request): Promise<Response> {
  const { loadStrategyConfig, saveStrategyConfig, getStrategyConfigPath } = await import('../tools/finance/strategy-config.js');

  if (req.method === 'GET') {
    return jsonResponse({ path: getStrategyConfigPath(), config: loadStrategyConfig() });
  }
  if (req.method === 'PUT') {
    try {
      const body = await req.text();
      const parsed = body ? JSON.parse(body) : {};
      const merged = { ...loadStrategyConfig(), ...parsed };
      saveStrategyConfig(merged);
      return jsonResponse({ ok: true, config: merged });
    } catch (err) {
      return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }
  return jsonResponse({ error: 'Method not allowed' }, 405);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function serveStatic(filePath: string): Response {
  if (!existsSync(filePath)) return new Response('Not Found', { status: 404 });
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  return new Response(readFileSync(filePath, 'utf-8'), { headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' } });
}

function corsRes(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ---------------------------------------------------------------------------
// Server entry
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.DEXTER_WEB_PORT || '3100', 10);

Bun.serve({
  port: PORT,
  idleTimeout: 30, // 30s timeout (was default 10s, too short for analysis)
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return corsRes();

    // SSE endpoints
    if (url.pathname === '/api/analyze') return handleAnalyzeSSE(url);
    if (url.pathname === '/api/chat')    return handleChat(req);

    // REST endpoints
    if (url.pathname.startsWith('/api/history')) return handleHistory(req, url);
    if (url.pathname === '/api/chart')           return handleChartAPI(req);
    if (url.pathname === '/api/strategy')         return handleStrategy(req);

    // Static
    if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(CLIENT_HTML);

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`\n  ═══════════════════════════`);
console.log(`   QuantAgent Web Server`);
console.log(`  ═══════════════════════════`);
console.log(`   Local:      http://localhost:${PORT}`);
console.log(`   Analyze SSE: http://localhost:${PORT}/api/analyze?ticker=09868`);
console.log(`   Chat SSE:   POST http://localhost:${PORT}/api/chat`);
console.log(`   Chart API:  POST http://localhost:${PORT}/api/chart`);
console.log(`   History:     http://localhost:${PORT}/api/history`);
console.log(`   Strategy:    http://localhost:${PORT}/api/strategy`);
console.log(`  ═══════════════════════════\n`);
