import type { ModelConfig } from './types';

/**
 * Provider registry — maps provider IDs to their configurations.
 *
 * To add a new provider, add an entry here and set the required env var.
 * All OpenAI-compatible providers (DeepSeek, xAI, OpenRouter, Moonshot)
 * use the same client code, differing only in baseURL and default model.
 */
const Providers: Record<string, ModelConfig> = {
  deepseek: {
    id: 'deepseek',
    displayName: 'DeepSeek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-v4-pro',
    fastModel: 'deepseek-v4-flash',
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    fastModel: 'gpt-4o-mini',
  },
  xai: {
    id: 'xai',
    displayName: 'xAI',
    apiKeyEnv: 'XAI_API_KEY',
    baseURL: 'https://api.x.ai/v1',
    defaultModel: 'grok-3',
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o',
  },
  moonshot: {
    id: 'moonshot',
    displayName: 'Moonshot',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
  },
};

/**
 * Get the active provider from LLM_PROVIDER env var, defaulting to 'deepseek'.
 */
export function getActiveProvider(): ModelConfig {
  const id = process.env.LLM_PROVIDER?.toLowerCase() ?? 'deepseek';
  const config = Providers[id];
  if (!config) {
    const available = Object.keys(Providers).join(', ');
    throw new Error(
      `Unknown LLM provider "${id}". Available: ${available}. Set LLM_PROVIDER in .env.`,
    );
  }
  // Verify the required API key is set
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `[${config.displayName}] ${config.apiKeyEnv} not found. Set it in .env or switch LLM_PROVIDER.`,
    );
  }
  return config;
}

/**
 * Resolve a model name — if prefixed with a known provider id (e.g. "openai:gpt-4o"),
 * return a config using that provider with the specified model.
 */
export function resolveModel(spec: string): ModelConfig {
  const colonIdx = spec.indexOf(':');
  if (colonIdx === -1) {
    const config = getActiveProvider();
    return { ...config, defaultModel: spec };
  }

  const prefix = spec.slice(0, colonIdx);
  const model = spec.slice(colonIdx + 1);
  const config = Providers[prefix.toLowerCase()];
  if (!config) {
    throw new Error(
      `Unknown provider prefix "${prefix}" in model spec "${spec}". ` +
      `Available: ${Object.keys(Providers).join(', ')}.`,
    );
  }
  return { ...config, defaultModel: model };
}

export { Providers };
