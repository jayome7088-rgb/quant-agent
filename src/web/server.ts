// QuantAgent Web Server — Bun.serve + SSE + WebSocket, zero extra dependencies.
import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'url';
import type { ServerWebSocket } from 'bun';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_HTML = join(__dirname, 'client.html');

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

let sseId = 0;
const sseClients = new Map<number, { controller: ReadableStreamDefaultController }>();

function sseEncode(event: string, data: string): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${data}\n\n`);
}

// WebSocket broadcasting
const wsClients = new Set<ServerWebSocket<undefined>>();

function wsBroadcast(data: string): void {
  for (const ws of wsClients) {
    try { ws.send(data); } catch { wsClients.delete(ws); }
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

  const stream = new ReadableStream({
    async start(controller) {
      const client = { id: ++sseId, controller };
      sseClients.set(client.id, client);

      const send = (event: string, data: string) => {
        try { controller.enqueue(sseEncode(event, data)); } catch { /* closed */ }
      };

      let finalResult = '';

      try {
        const { createStockAnalyzer } = await import('../tools/finance/stock-analyzer.js');

        const tool = createStockAnalyzer();
        send('progress', JSON.stringify({ stage: 'starting', message: `开始分析 ${ticker}…` }));

        const result = await tool.invoke(
          { ticker, interval },
          {
            metadata: {
              onProgress: (msg: string) => {
                send('progress', JSON.stringify({ stage: 'running', message: msg }));
                wsBroadcast(JSON.stringify({ type: 'progress', ticker, message: msg }));
              },
            },
          },
        );

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
        } catch { /* not JSON wrapped */ }

        // Emit plot events for each chart
        for (const [chartType, dataUrl] of Object.entries(plots)) {
          send('plot', JSON.stringify({ chart_type: chartType, data_url: dataUrl }));
        }

        finalResult = text;
        send('result', text);
        send('done', JSON.stringify({ ticker, interval, complete: true }));

        // Save to history
        try {
          const { insertAnalysis } = await import('./history-db.js');
          insertAnalysis(ticker, interval, finalResult);
          wsBroadcast(JSON.stringify({ type: 'history_updated' }));
        } catch { /* history save failed — non-fatal */ }

        wsBroadcast(JSON.stringify({ type: 'analysis_complete', ticker, interval }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send('error', msg);
      } finally {
        sseClients.delete(client.id);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function handleChat(req: Request): Promise<Response> {
  let body: { query?: string; apiKey?: string; provider?: string } = {};
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { query, apiKey, provider } = body;
  if (!query?.trim()) {
    return jsonResponse({ error: 'Missing query' }, 400);
  }

  // Require user's own API key — no server default
  if (!apiKey?.trim()) {
    return jsonResponse({ error: '请提供你的 API Key（在聊天框下方输入）' }, 400);
  }

  // Set the user's API key into env for the agent
  const prov = provider || 'deepseek';
  const { Providers } = await import('../model/providers.js');
  const cfg = Providers[prov.toLowerCase()];
  if (!cfg) {
    return jsonResponse({ error: `Unknown provider: ${prov}` }, 400);
  }

  const keyEnv = cfg.apiKeyEnv;
  const prevKey = process.env[keyEnv] || '';
  process.env[keyEnv] = apiKey;

  const stream = new ReadableStream({
    async start(controller) {
      const client = { id: ++sseId, controller };
      sseClients.set(client.id, client);

      const send = (event: string, data: string) => {
        try { controller.enqueue(sseEncode(event, data)); } catch { /* closed */ }
      };

      try {
        const { Agent } = await import('../agent/agent.js');

        const agent = await Agent.create({
          model: `${prov}:${cfg.defaultModel}`,
          memoryEnabled: false,
          usePlanner: false,
        });

        send('status', JSON.stringify({ status: 'thinking' }));

        for await (const event of agent.run(query.trim())) {
          if (event.type === 'stream_progress') {
            const se = event as { type: 'stream_progress'; text?: string; mode: string };
            if (se.text) {
              send('token', JSON.stringify({ text: se.text, mode: se.mode }));
            }
          } else if (event.type === 'thinking') {
            const te = event as { type: 'thinking'; message: string };
            send('thinking', JSON.stringify({ text: te.message }));
          } else if (event.type === 'tool_start') {
            const te = event as { type: 'tool_start'; tool: string; args: Record<string, unknown> };
            send('tool_start', JSON.stringify({ tool: te.tool, args: te.args }));
          } else if (event.type === 'tool_end') {
            const te = event as { type: 'tool_end'; tool: string; result: string };
            const truncated = te.result.length > 2000 ? te.result.slice(0, 2000) + '…' : te.result;
            send('tool_end', JSON.stringify({ tool: te.tool, result: truncated }));
          } else if (event.type === 'tool_error') {
            const te = event as { type: 'tool_error'; tool: string; error: string };
            send('tool_error', JSON.stringify({ tool: te.tool, error: te.error }));
          } else if (event.type === 'done') {
            const de = event as { type: 'done'; answer: string; iterations: number; totalTime: number };
            send('done', JSON.stringify({ answer: de.answer, iterations: de.iterations, totalTime: de.totalTime }));
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send('error', JSON.stringify({ message: msg }));
      } finally {
        // Restore API key
        if (keyEnv) process.env[keyEnv] = prevKey;
        sseClients.delete(client.id);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function handleHistory(req: Request, url: URL): Promise<Response> {
  const { listAnalyses, getAnalysis, deleteAnalysis } = await import('./history-db.js');

  // Match /api/history/:id
  const idMatch = url.pathname.match(/^\/api\/history\/(\d+)$/);
  if (idMatch) {
    const id = parseInt(idMatch[1], 10);
    if (req.method === 'GET') {
      const entry = getAnalysis(id);
      if (!entry) return jsonResponse({ error: 'Not found' }, 404);
      return jsonResponse(entry);
    }
    if (req.method === 'DELETE') {
      deleteAnalysis(id);
      wsBroadcast(JSON.stringify({ type: 'history_updated' }));
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: 'Method not allowed' }, 405);
  }

  // GET /api/history
  if (req.method === 'GET') {
    const search = url.searchParams.get('search') || undefined;
    const sort = (url.searchParams.get('sort') || 'desc') as 'asc' | 'desc';
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const result = listAnalyses({ search, sort, limit, offset });
    return jsonResponse(result);
  }

  return jsonResponse({ error: 'Method not allowed' }, 405);
}

async function handleChartAPI(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Use POST with JSON body' }, 405);
  }

  let body: { chart_type?: string; data?: Record<string, unknown>; title?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { chart_type, data, title } = body;
  if (!chart_type || !data) {
    return jsonResponse({ error: 'Missing chart_type or data' }, 400);
  }

  try {
    const { generateChart } = await import('../tools/finance/plot-bridge.js');
    const result = await generateChart(
      chart_type as 'equity_curve' | 'indicator_overlay' | 'feature_importance' | 'feature_importance_bar' | 'candlestick' | 'backtest_metrics_table',
      data,
      title,
    );
    return jsonResponse({ chart_type: result.chart_type, data_url: `data:image/png;base64,${result.base64}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: msg }, 500);
  }
}

async function handleStrategy(req: Request): Promise<Response> {
  const { loadStrategyConfig, saveStrategyConfig, getStrategyConfigPath } = await import('../tools/finance/strategy-config.js');

  if (req.method === 'GET') {
    const config = loadStrategyConfig();
    return jsonResponse({ path: getStrategyConfigPath(), config });
  }

  if (req.method === 'PUT') {
    try {
      const body = await req.text();
      const parsed = body ? JSON.parse(body) : {};
      const current = loadStrategyConfig();
      const merged = { ...current, ...parsed };
      saveStrategyConfig(merged);
      wsBroadcast(JSON.stringify({ type: 'strategy_updated', config: merged }));
      return jsonResponse({ ok: true, config: merged });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: msg }, 400);
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
  if (!existsSync(filePath)) {
    return new Response('Not Found', { status: 404 });
  }
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  return new Response(readFileSync(filePath, 'utf-8'), {
    headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' },
  });
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function corsHeaders(): Headers {
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return h;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.DEXTER_WEB_PORT || '3100', 10);

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return undefined as unknown as Response;
    }

    // SSE: stock analysis
    if (url.pathname === '/api/analyze') {
      return handleAnalyzeSSE(url);
    }

    // SSE: agent chat
    if (url.pathname === '/api/chat') {
      return handleChat(req);
    }

    // History API
    if (url.pathname.startsWith('/api/history')) {
      return handleHistory(req, url);
    }

    // Chart generation API
    if (url.pathname === '/api/chart') {
      return handleChartAPI(req);
    }

    // Strategy config
    if (url.pathname === '/api/strategy') {
      return handleStrategy(req);
    }

    // Static
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return serveStatic(CLIENT_HTML);
    }

    return new Response('Not Found', { status: 404 });
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      ws.send(JSON.stringify({ type: 'connected', clients: wsClients.size }));
    },
    close(ws) {
      wsClients.delete(ws);
    },
    message(_ws, _message) {
      // Client messages handled here if needed
    },
  },
});

  console.log(`\n  QuantAgent Web Server`);
console.log(`  ─────────────────────`);
console.log(`  Local:   http://localhost:${PORT}`);
console.log(`  Analyze: http://localhost:${PORT}/api/analyze?ticker=09868`);
console.log(`  Chat:    POST http://localhost:${PORT}/api/chat`);
console.log(`  Chart:   POST http://localhost:${PORT}/api/chart`);
console.log(`  History: http://localhost:${PORT}/api/history`);
console.log(`  WS:      ws://localhost:${PORT}/ws`);
console.log();
