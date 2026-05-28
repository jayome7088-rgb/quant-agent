/**
 * LLM adapter — bridges LangChain message types to the native ModelProvider.
 *
 * The agent code (agent.ts, compact.ts, memory/flush.ts) imports these
 * functions. They now delegate to ModelProvider.factory under the hood,
 * converting between OpenAI-compatible responses and LangChain message types.
 *
 * Streaming is driven by the OpenAI SDK's native SSE iterator — NOT by
 * LangChain callbacks.
 */

import { AIMessage, AIMessageChunk, BaseMessage, SystemMessage, HumanMessage } from '@langchain/core/messages';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { createModel, type StreamDelta } from './factory';
import { getActiveProvider } from './providers';
import type { TokenUsage as AgentTokenUsage } from '@/agent/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDER = 'deepseek';
export const DEFAULT_MODEL = 'deepseek-v4-pro';

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  provider: string,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        `[${provider}] API error (attempt ${attempt + 1}/${maxAttempts}): ${message}`,
      );

      if (attempt === maxAttempts - 1) {
        throw new Error(`[${provider}] ${message}`);
      }

      // Only retry on transient errors
      if (isNonRetryable(message)) throw new Error(`[${provider}] ${message}`);

      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error('Unreachable');
}

function isNonRetryable(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('invalid api key') ||
    lower.includes('incorrect api key') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('not found') ||
    lower.includes('model not found')
  );
}

// ---------------------------------------------------------------------------
// Usage extraction
// ---------------------------------------------------------------------------

function extractUsage(result: unknown): AgentTokenUsage | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const msg = result as Record<string, unknown>;

  const um = msg.usage_metadata as Record<string, unknown> | undefined;
  if (um) {
    const input = typeof um.input_tokens === 'number' ? um.input_tokens : 0;
    const output = typeof um.output_tokens === 'number' ? um.output_tokens : 0;
    const total = typeof um.total_tokens === 'number' ? um.total_tokens : input + output;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Streaming delta → AIMessageChunk conversion
// ---------------------------------------------------------------------------

/**
 * Convert a native StreamDelta into a LangChain AIMessageChunk.
 * The agent loop calls `.concat()` on these chunks to build the final
 * AIMessage with complete tool_calls.
 */
function deltaToChunk(delta: StreamDelta): AIMessageChunk {
  const chunkFields: Record<string, unknown> = {};

  // Text content
  if (delta.content) {
    chunkFields.content = delta.content;
  }

  // Reasoning / thinking
  if (delta.reasoning) {
    chunkFields.additional_kwargs = {
      ...((chunkFields.additional_kwargs as Record<string, unknown>) ?? {}),
      reasoning_content: delta.reasoning,
    };
  }

  // Tool call deltas (incremental)
  if (delta.toolCallDeltas?.length) {
    chunkFields.tool_call_chunks = delta.toolCallDeltas.map((tc) => ({
      index: tc.index,
      id: tc.id || undefined,
      name: tc.name || undefined,
      args: tc.arguments,
    }));
  }

  // Usage metadata (final chunk only)
  if (delta.usage) {
    chunkFields.usage_metadata = {
      input_tokens: delta.usage.inputTokens,
      output_tokens: delta.usage.outputTokens,
      total_tokens: delta.usage.totalTokens,
    };
  }

  return new AIMessageChunk(chunkFields);
}

// ---------------------------------------------------------------------------
// Chat result → AIMessage conversion
// ---------------------------------------------------------------------------

function chatResultToAIMessage(result: {
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}): AIMessage {
  return new AIMessage({
    content: result.content || '',
    tool_calls: result.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.arguments,
    })),
    usage_metadata: result.usage
      ? {
          input_tokens: result.usage.inputTokens,
          output_tokens: result.usage.outputTokens,
          total_tokens: result.usage.totalTokens,
        }
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// Public API — single-turn
// ---------------------------------------------------------------------------

export interface LlmResult {
  response: AIMessage | string | Record<string, unknown>;
  usage?: AgentTokenUsage;
}

interface CallLlmOptions {
  model?: string;
  systemPrompt?: string;
  outputSchema?: z.ZodType<unknown>;
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
}

/**
 * Single-turn call with a system prompt + user prompt string.
 * Used by compaction, memory flush, and simple utilities.
 */
export async function callLlm(
  prompt: string,
  options: CallLlmOptions = {},
): Promise<LlmResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const provider = createModel(model);
  const systemPrompt = options.systemPrompt ?? '';

  const messages: BaseMessage[] = [];
  if (systemPrompt) {
    messages.push(new SystemMessage(systemPrompt));
  }
  messages.push(new HumanMessage(prompt));

  const result = await withRetry(
    () =>
      provider.chat(messages, {
        model,
        tools: options.tools,
        signal: options.signal,
      }),
    provider.config.displayName,
  );

  // If neither tools nor outputSchema: return plain string
  if (!options.outputSchema && !options.tools?.length) {
    return {
      response: result.content,
      usage: result.usage,
    };
  }

  // With outputSchema (no tools): parse JSON content through schema, return validated object
  if (options.outputSchema && !options.tools?.length) {
    try {
      const content = result.content.trim();
      const json = JSON.parse(content) as unknown;
      const validated = options.outputSchema.parse(json) as Record<string, unknown>;
      return {
        response: validated,
        usage: result.usage,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Structured output validation failed: ${message}. Raw content: ${result.content.slice(0, 300)}`);
    }
  }

  // With tools: return full AIMessage preserving tool_calls
  return {
    response: chatResultToAIMessage(result),
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// Public API — multi-turn (agent loop)
// ---------------------------------------------------------------------------

interface CallLlmWithMessagesOptions {
  model?: string;
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
}

/**
 * Multi-turn blocking call with full message array.
 *
 * Accepts BaseMessage[] (SystemMessage, HumanMessage, AIMessage, ToolMessage)
 * and returns a LangChain AIMessage with optional tool_calls. This is the
 * primary call used by the agent loop.
 */
export async function callLlmWithMessages(
  messages: BaseMessage[],
  options: CallLlmWithMessagesOptions = {},
): Promise<LlmResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const provider = createModel(model);

  const result = await withRetry(
    () =>
      provider.chat(messages, {
        model,
        tools: options.tools,
        signal: options.signal,
      }),
    provider.config.displayName,
  );

  return {
    response: chatResultToAIMessage(result),
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// Public API — streaming (the key part)
// ---------------------------------------------------------------------------

/**
 * Stream an LLM response as LangChain AIMessageChunk objects.
 *
 * Streaming is powered by the OpenAI SDK's native SSE iterator (not LangChain
 * callbacks). Each chunk is converted to AIMessageChunk so the agent's
 * `.concat()` accumulation logic works unchanged.
 */
export async function* streamLlmWithMessages(
  messages: BaseMessage[],
  options: CallLlmWithMessagesOptions = {},
): AsyncGenerator<AIMessageChunk, void> {
  const model = options.model ?? DEFAULT_MODEL;
  const provider = createModel(model);

  const stream = provider.stream(messages, {
    model,
    tools: options.tools,
    signal: options.signal,
  });

  for await (const delta of stream) {
    yield deltaToChunk(delta);
  }
}

// ---------------------------------------------------------------------------
// Legacy compat — getChatModel / getFastModel
// ---------------------------------------------------------------------------

/**
 * Returns the fast model for the current provider.
 */
export function getFastModel(fallbackModel: string): string {
  const config = getActiveProvider();
  return config.fastModel ?? fallbackModel;
}
