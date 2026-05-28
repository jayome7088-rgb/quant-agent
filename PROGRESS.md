# Dexter Pro — Development Progress

> Base: [virattt/dexter](https://github.com/virattt/dexter) (MIT License, ~25K stars)
> Started: 2026-05-23

---

## Phase 1 — Project Initialization & ModelFactory ✅

**Commit:** `93a4619` | **Status:** Compiling (tsc --noEmit: 0 errors)

### Changes Made

#### Dependency Streamlining
| | Before | After |
|---|---|---|
| Dependencies | 24 packages | 9 packages |
| LangChain packages | 8 (@langchain/*) | 1 (@langchain/core) |
| UI framework | @mariozechner/pi-tui | ink v5 |
| LLM SDK | LangChain Chat* classes | openai SDK (native) |
| Removed | playwright, baileys, exa-js, gray-matter, diff, linkedom, readability, croner, langsmith, qrcode-terminal | — |

#### New Model Layer (`src/model/`)
| File | Purpose |
|---|---|
| `factory.ts` | `ModelProvider` class — wraps OpenAI SDK, native SSE streaming via `client.chat.completions.create({ stream: true })`. No LangChain callbacks. |
| `providers.ts` | 5 providers registered: DeepSeek (default), OpenAI, xAI, OpenRouter, Moonshot. All use OpenAI-compatible protocol. |
| `types.ts` | `toOpenAIMessages()` / `toOpenAITools()` converters. Runtime Zod→JSON Schema extraction (compatible with both Zod v3 and v4). |
| `llm.ts` | Adapter layer — keeps `callLlm`, `callLlmWithMessages`, `streamLlmWithMessages` signatures. Delegates to ModelProvider internally. |
| `index.ts` | Barrel export. |

#### Modified Files
- `src/providers.ts` — default provider changed from `openai` to `deepseek`
- `env.example` — simplified to LLM_PROVIDER + DEEPSEEK_API_KEY + FINANCIAL_DATASETS_API_KEY
- `src/memory/embeddings.ts` — uses `openai` SDK + Ollama HTTP (removed @langchain/google-genai, @langchain/ollama, @langchain/openai)
- `src/skills/registry.ts` — simplified (removed gray-matter dependency)
- `src/tools/registry.ts` — removed browser/search/fetch/filesystem/cron/heartbeat tools
- `src/tools/index.ts` — cleaned up exports
- `src/index.tsx` — minimal entry point stub

#### Deleted Directories/Files
Removed all code referencing deleted packages:
- `src/components/` (pi-tui UI)
- `src/cli.ts` (old CLI entry)
- `src/controllers/`, `src/commands/`
- `src/evals/` (LangSmith)
- `src/gateway/` (WhatsApp)
- `src/cron/`, `src/tools/cron/`
- `src/tools/browser/`
- `src/tools/search/`
- `src/tools/fetch/`
- `src/tools/filesystem/`
- `src/tools/heartbeat/`
- `src/utils/spinner.ts`

### Key Architecture Decisions
1. **Streaming bypasses LangChain** — OpenAI SDK native `stream: true` SSE iterator. LangChain only provides type definitions.
2. **DeepSeek is default** — `LLM_PROVIDER=deepseek`, `DEEPSEEK_API_KEY` required.
3. **Zod v3/v4 compatibility** — LangChain core uses Zod v3 types; project uses Zod v4. Tool schema conversion works at runtime via duck-typing.
4. **Model layer is fully swappable** — other providers activated by changing `LLM_PROVIDER` in `.env`.

### Verification
```bash
bun install          # 43 packages, ~4s
bun run typecheck    # tsc --noEmit: 0 errors
```

---

## Phase 2 — Agent Loop E2E Verification ✅

**Commit:** `7c88175` | **Status:** Verified with real DeepSeek V4 Pro API

### Changes Made
- Fixed `agent.ts:23` — removed local `DEFAULT_MODEL = 'gpt-5.5'`, now imports from `model/llm.ts` (`deepseek-v4-pro`)
- Updated `utils/config.ts` — added `deepseek-v4-pro` and `deepseek-v4-flash` to provider map
- Created `src/verify-e2e.ts` — end-to-end verification script with streaming display

### Verification Results
| Metric | Value |
|---|---|
| Iterations | 1 (conversational, no tools needed) |
| Input tokens | 4,186 |
| Output tokens | 447 |
| Speed | 295 t/s |
| Agent loop | requesting → responding → done ✓ |
| Streaming | Typewriter effect via OpenAI SDK SSE ✓ |

### Bug Fixed
- Model name `gpt-5.5` was hardcoded in `agent.ts`, causing DeepSeek 400 error. Changed to import `DEFAULT_MODEL` from the model layer.

---

## Phase 3 — Task Planner ✅

**Commit:** `526f435` | **Status:** Verified with real DeepSeek V4 Pro API (3/3 tests pass)

### Changes Made

#### New Planner Module (`src/planner/`)
| File | Purpose |
|---|---|
| `types.ts` | `ResearchPlan` / `ResearchStep` interfaces, `RawPlanSchema` (Zod v4), `normalizePlan()` fills in defaults |
| `planner.ts` | `createPlan(query, modelSpec)` — calls LLM to decompose financial query into steps. Fast model first, fallback to main. Handles markdown-fenced and bare JSON. |
| `validator.ts` | `validatePlan(plan)` — checks duplicate IDs, missing deps, DFS cycle detection. `PlanValidationError` with structured errors + warnings. |
| `index.ts` | Barrel exports. |

#### Modified Files
- `src/agent/prompts.ts` — added "Research Planning" section between Tool Usage Policy and Skills, instructing the agent to decompose multi-step queries, sequence data-fetching before analysis, and think aloud.

#### New Verification Script
- `src/verify-planner.ts` — runs 3 increasingly complex queries through `createPlan()`, validates structure (IDs, deps, tool names, step count).

### Verification Results
| Test | Query | Steps | Time |
|---|---|---|---|
| Multi-company comparison | AAPL vs MSFT revenue growth + margins | 5 | 28.9s |
| Stock screening | Tech P/E<20, growth>15%, cap>50B | 3 | 42.4s |
| Single company deep dive | NVDA PEG vs semiconductor avg | 3 | 28.3s |

All plans had valid dependency graphs, correct tool names, and appropriate step counts (3-5).

### Key Architecture Decisions
1. **LLM-driven decomposition** — the planner calls DeepSeek V4 Pro to generate the plan, no hand-crafted rules.
2. **Two-attempt retry** — first try uses fast model; on JSON parse failure, falls back to the main model.
3. **DFS cycle detection** — validates dependency graph before returning plan to agent.
4. **Tool-aware** — planner prompt includes full tool list, so generated plans reference real tool names.
5. **No streaming for plans** — planning is blocking (single `chat()` call), since the result is needed before execution begins.

---

## Phase 4 — Financial Data Tools Verification ✅

**Commit:** `c353624` | **Status:** Verified with real Financial Datasets API (7/7 tests pass)

### Bugs Fixed
1. **`get_financials` router prompt** — referenced nonexistent tool `get_financial_metrics_snapshot` → corrected to `get_key_ratios`
2. **`get_market_data` router prompt** — referenced `get_stock_tickers` → corrected to `get_available_stock_tickers`; `get_crypto_tickers` → `get_available_crypto_tickers`
3. **`formatters.ts` registry key** — `get_stock_price_snapshot` didn't match actual tool name `get_stock_price` → fixed
4. **`callLlm` outputSchema handling** — `outputSchema` parameter was accepted but ignored; LLM response was returned as AIMessage wrapper instead of parsed JSON object. This broke `stock_screener` and `read_filings` (both use structured output). Fixed by parsing `result.content` through the Zod schema when `outputSchema` is provided.

### Verification Results
| # | Tool | Query | Result |
|---|---|---|---|
| 1 | get_financials | AAPL key metrics | ✓ Market Cap 4.5T, margins, D/E (3.7s) |
| 2 | get_financials | MSFT 3-year income | ✓ 281.7B/245.1B/211.9B revenue (3.1s) |
| 3 | get_market_data | NVDA stock price | ✓ $214.30 (3.2s) |
| 4 | get_market_data | TSLA news | ✓ Real headlines from May 2026 (2.4s) |
| 5 | stock_screener | Tech P/E<30, growth>10% | ✓ Filters parsed correctly (11.6s) |
| 6 | stock_screener | Healthcare ROE>15% | ✓ Filters parsed correctly (8.3s) |
| 7 | read_filings | AAPL 10-K risk factors | ✓ Item 1A content from SEC retrieved (11.2s) |

All 4 meta-tools verified: LLM routing → sub-tool selection → API call → formatter pipeline works end-to-end.

### Key Architecture Decisions
1. **Meta-tool pattern** — each tool (`get_financials`, `get_market_data`, `read_filings`, `stock_screener`) is an LLM-powered router: natural language query → sub-tool selection → parallel execution → formatted output
2. **Formatter layer** — raw API JSON is converted to compact markdown tables by type-specific formatters, reducing token usage 5-10x
3. **API caching** — immutable data (historical prices, SEC filings) cached with TTL; mutable data (snapshots) cached short-term
4. **Data source** — single source (Financial Datasets API) with `/financials/`, `/prices/`, `/filings/`, `/crypto/` endpoints; architecture supports adding more sources

---

## Upcoming Phases
| # | Goal |
|---|---|
| 5 | Agent Executor + Self-Validation Loop |
| 6 | CLI UI — Ink v5 multi-panel terminal interface |
| 7 | Local Memory (SQLite + vector search) + Report Export |
| 8 | Testing, docs, deployment prep |

---

*Last updated: 2026-05-24*
