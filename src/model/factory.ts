import OpenAI from 'openai';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  getActiveProvider,
  resolveModel,
} from './providers';
import {
  toOpenAIMessages,
  toOpenAITools,
  type ChatOptions,
  type ChatResult,
  type TokenUsage,
  type ToolCall,
} from './types';

// ---------------------------------------------------------------------------
// Low-level: raw OpenAI stream iterator
// ---------------------------------------------------------------------------

/**
 * A raw delta from the OpenAI streaming API.
 * Text deltas carry `content`; tool-call deltas carry incremental
 * `tool_calls` arrays whose `function.arguments` must be accumulated.
 */
export interface StreamDelta {
  /** Non-empty when the model is emitting text (thinking or final answer). */
  content: string;
  /** Non-empty when a tool call is being built up chunk by chunk. */
  toolCallDeltas?: Array<{
    index: number;
    id?: string;
    name?: string;
    arguments: string;
  }>;
  /** The model's reasoning / thinking output (DeepSeek V4, o1, etc.). */
  reasoning: string;
  /** Set on the final chunk of a stream. */
  usage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// ModelProvider — wraps an OpenAI-compatible client
// ---------------------------------------------------------------------------

export class ModelProvider {
  private client: OpenAI;
  public readonly config: ReturnType<typeof getActiveProvider>;
  private currentModel: string;

  constructor(modelSpec?: string) {
    this.config = modelSpec ? resolveModel(modelSpec) : getActiveProvider();
    this.currentModel = this.config.defaultModel;

    this.client = new OpenAI({
      apiKey: process.env[this.config.apiKeyEnv]!,
      baseURL: this.config.baseURL,
    });
  }

  /** The model name currently in use (after resolution). */
  get model(): string {
    return this.currentModel;
  }

  // -----------------------------------------------------------------------
  // Non-streaming chat
  // -----------------------------------------------------------------------

  /**
   * Blocking chat call with tool definitions. Returns content + optional
   * tool calls + usage metadata.
   */
  async chat(
    messages: Parameters<typeof toOpenAIMessages>[0],
    options: ChatOptions = {},
  ): Promise<ChatResult> {
    const model = options.model ?? this.currentModel;
    const oaiMessages = toOpenAIMessages(messages);
    const oaiTools = options.tools?.length
      ? toOpenAITools(options.tools)
      : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = await this.client.chat.completions.create(
      {
        model,
        messages: oaiMessages as any,
        tools: oaiTools as any,
        stream: false,
      } as any,
      options.signal ? { signal: options.signal } : undefined,
    );

    const choice = resp.choices[0]!;
    return {
      content: choice.message?.content ?? '',
      toolCalls: this.parseToolCalls(choice.message?.tool_calls),
      usage: resp.usage
        ? {
            inputTokens: resp.usage.prompt_tokens,
            outputTokens: resp.usage.completion_tokens,
            totalTokens: resp.usage.total_tokens,
          }
        : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // Streaming chat — the core of the CLI typewriter effect
  // -----------------------------------------------------------------------

  /**
   * Stream an LLM response as `StreamDelta` events.
   *
   * Each yielded delta carries incremental text, reasoning, and/or tool-call
   * fragment. The CLI layer can use these to animate a typewriter effect.
   *
   * **Explicitly does NOT use LangChain callbacks.** Streaming is driven
   * entirely by the OpenAI SDK's native SSE iterator.
   */
  async *stream(
    messages: Parameters<typeof toOpenAIMessages>[0],
    options: ChatOptions = {},
  ): AsyncGenerator<StreamDelta> {
    const model = options.model ?? this.currentModel;
    const oaiMessages = toOpenAIMessages(messages);
    const oaiTools = options.tools?.length
      ? toOpenAITools(options.tools)
      : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = await this.client.chat.completions.create(
      {
        model,
        messages: oaiMessages as any,
        tools: oaiTools as any,
        stream: true,
        stream_options: { include_usage: true },
      } as any,
      options.signal ? { signal: options.signal } : undefined,
    ) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    // Accumulate tool calls across chunks (they arrive as partial JSON)
    const toolCallAccum: Map<number, { id: string; name: string; args: string }> =
      new Map();

    for await (const chunk of stream) {
      const delta: StreamDelta = { content: '', reasoning: '' };
      const choice = chunk.choices?.[0];

      if (!choice) continue;

      // Reasoning / thinking content (DeepSeek V4, o1, etc.)
      if (isReasoningDelta(choice.delta)) {
        const reasoning =
          (choice.delta as unknown as { reasoning_content?: string })
            .reasoning_content ?? '';
        delta.reasoning = reasoning;
      }

      // Text content
      if (choice.delta?.content) {
        delta.content = choice.delta.content;
      }

      // Tool call deltas (arrive incrementally)
      if (choice.delta?.tool_calls) {
        const deltas: StreamDelta['toolCallDeltas'] = [];
        for (const tc of choice.delta.tool_calls) {
          const idx = tc.index;
          const existing = toolCallAccum.get(idx) ?? {
            id: '',
            name: '',
            args: '',
          };

          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;

          toolCallAccum.set(idx, existing);
          deltas.push({
            index: idx,
            id: existing.id,
            name: existing.name,
            arguments: existing.args,
          });
        }
        delta.toolCallDeltas = deltas;
      }

      // Usage (only on final chunk when stream_options.include_usage is set)
      if (chunk.usage) {
        delta.usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }

      // Only yield if there's something to report
      if (delta.content || delta.reasoning || delta.toolCallDeltas || delta.usage) {
        yield delta;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private parseToolCalls(
    raw?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
  ): ToolCall[] | undefined {
    if (!raw?.length) return undefined;
    return raw.map((tc) => {
      // OpenAI SDK v5: tool calls can be ChatCompletionMessageToolCall
      // (has .function) or ChatCompletionMessageCustomToolCall (no .function).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (tc as any).function;
      return {
        id: tc.id,
        name: fn?.name ?? 'unknown',
        arguments: safeJsonParse(fn?.arguments ?? '{}'),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a ModelProvider for the configured LLM provider.
 *
 * @param modelSpec — optional model override, e.g. "deepseek-v4-flash" or "openai:gpt-4o"
 */
export function createModel(modelSpec?: string): ModelProvider {
  return new ModelProvider(modelSpec);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isReasoningDelta(delta: unknown): boolean {
  if (!delta || typeof delta !== 'object') return false;
  return 'reasoning_content' in (delta as Record<string, unknown>);
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
