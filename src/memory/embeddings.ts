import OpenAI from 'openai';
import type { EmbeddingProviderId, MemoryEmbeddingClient } from './types.js';

const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
const EMBEDDING_BATCH_SIZE = 64;
const EMBEDDING_TIMEOUT_MS = 15_000;

type ResolvedProvider = Exclude<EmbeddingProviderId, 'auto' | 'none'>;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function resolveProvider(preferred: EmbeddingProviderId): ResolvedProvider | null {
  if (preferred === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (preferred === 'ollama' && process.env.OLLAMA_BASE_URL) return 'ollama';
  if (preferred === 'auto') {
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.env.OLLAMA_BASE_URL) return 'ollama';
  }
  return null;
}

async function embedInBatches(
  texts: string[],
  embedBatch: (batch: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const result = await withTimeout(
      embedBatch(batch),
      EMBEDDING_TIMEOUT_MS,
      'Embedding API timed out',
    );
    vectors.push(...result);
  }
  return vectors;
}

export function createEmbeddingClient(params: {
  provider: EmbeddingProviderId;
  model?: string;
}): MemoryEmbeddingClient | null {
  const resolved = resolveProvider(params.provider);
  if (!resolved) return null;

  if (resolved === 'openai') {
    const model = params.model || DEFAULT_OPENAI_MODEL;
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    });
    return {
      provider: 'openai',
      model,
      embed: async (texts: string[]) =>
        embedInBatches(texts, async (batch) => {
          const resp = await client.embeddings.create({
            model,
            input: batch,
          });
          return resp.data
            .sort((a, b) => a.index - b.index)
            .map((d) => d.embedding);
        }),
    };
  }

  // Ollama embeddings
  const model = params.model || 'nomic-embed-text';
  const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
  return {
    provider: 'ollama',
    model,
    embed: async (texts: string[]) =>
      embedInBatches(texts, async (batch) => {
        const resp = await fetch(`${baseUrl}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: batch }),
        });
        const json = (await resp.json()) as { embeddings: number[][] };
        return json.embeddings;
      }),
  };
}

export async function embedSingleQuery(
  client: MemoryEmbeddingClient | null,
  query: string,
): Promise<number[] | null> {
  if (!client) return null;
  const vectors = await withTimeout(
    client.embed([query]),
    EMBEDDING_TIMEOUT_MS,
    'Embedding query timed out',
  );
  return vectors[0] ?? null;
}
