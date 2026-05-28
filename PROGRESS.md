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

## Phase 2 — Agent Loop E2E Verification 🔜

**Planned:**
- Write E2E test script (`src/verify-e2e.ts`)
- Verify Agent.create() → LLM call → streaming output → tool calls → final answer
- Test with real DeepSeek API key

---

## Upcoming Phases
| # | Goal |
|---|---|
| 3 | Task Planner — structured research step decomposition |
| 4 | Financial Data Tools — multi-source data layer |
| 5 | Agent Executor + Self-Validation Loop |
| 6 | CLI UI — Ink v5 multi-panel terminal interface |
| 7 | Local Memory (SQLite + vector search) + Report Export |
| 8 | Testing, docs, deployment prep |

---

*Last updated: 2026-05-24*
