import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export interface ModelConfig {
  id: string;
  displayName: string;
  apiKeyEnv: string;
  baseURL: string;
  defaultModel: string;
  fastModel?: string;
}

// ---------------------------------------------------------------------------
// Chat options & results
// ---------------------------------------------------------------------------

export interface ChatOptions {
  model?: string;
  tools?: StructuredToolInterface[];
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResult {
  content: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
}

// ---------------------------------------------------------------------------
// OpenAI message format conversion
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Convert LangChain BaseMessage array to OpenAI-compatible message format.
 */
export function toOpenAIMessages(messages: BaseMessage[]): OpenAIMessage[] {
  return messages.map((msg) => {
    const type = msg._getType();

    switch (type) {
      case 'system':
        return {
          role: 'system' as const,
          content: contentAsString(msg.content),
        };

      case 'human':
        return {
          role: 'user' as const,
          content: contentAsString(msg.content),
        };

      case 'ai': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const aiMsg = msg as any;
        const rawCalls = aiMsg.tool_calls as Array<{
          id?: string;
          name: string;
          args: Record<string, unknown>;
        }> | undefined;

        const toolCalls: OpenAIToolCall[] | undefined = rawCalls?.map((tc) => ({
          id: tc.id ?? crypto.randomUUID(),
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        }));

        return {
          role: 'assistant' as const,
          content: contentAsString(aiMsg.content) || null,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
        };
      }

      case 'tool': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolMsg = msg as any;
        return {
          role: 'tool' as const,
          content: contentAsString(toolMsg.content),
          tool_call_id: (toolMsg.tool_call_id as string) ?? '',
        };
      }

      default:
        return {
          role: 'user' as const,
          content: contentAsString(msg.content),
        };
    }
  });
}

/**
 * Convert LangChain StructuredTool array to OpenAI tool definitions.
 *
 * Extracts JSON Schema from the tool's Zod schema at runtime, bypassing the
 * Zod v3/v4 type mismatch between LangChain and our local `zod` version.
 */
export function toOpenAITools(tools: StructuredToolInterface[]): OpenAIToolDef[] {
  return tools.map((tool) => {
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: extractJsonSchema(tool.schema),
      },
    };
  });
}

/**
 * Extract JSON Schema from a LangChain ToolInputSchemaBase at runtime.
 *
 * LangChain Core bundles a Zod v3-like schema object, but this project uses
 * Zod v4. We cannot use `instanceof` checks (different class hierarchies).
 * Instead we sniff the runtime shape and call the serialiser if available.
 */
function extractJsonSchema(schema: unknown): Record<string, unknown> {
  // Zod v4 — preferred path
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = schema as any;

  if (typeof s?.toJSONSchema === 'function') {
    try {
      return s.toJSONSchema() as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  // Zod v3 — _zod is an internal marker, shape() or describe() may work
  if (typeof s?.describe === 'function') {
    try {
      const desc = s.describe() as string;
      // Minimal: just return an object container; the description string
      // carries parameter info that the LLM can read.
      return { type: 'object', properties: {}, description: desc };
    } catch {
      // fall through
    }
  }

  // Last resort — a blank object schema. The LLM will infer parameter
  // structure from the tool's `description` and `name`.
  return { type: 'object', properties: {} };
}

/**
 * Extract text content from LangChain's polymorphic content field.
 */
function contentAsString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>).type === 'text',
      )
      .map((part) => part.text)
      .join('');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}
