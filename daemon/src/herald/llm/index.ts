import type { ResolvedHeraldConfig } from '../config';
import type { LlmProvider } from './provider';
import { OpenAiCompatibleProvider } from './openai-compatible';
import { AnthropicProvider } from './anthropic';

export * from './provider';

/** Build the configured provider, or null when the brain is not configured. */
export function createProvider(cfg: ResolvedHeraldConfig): LlmProvider | null {
  if (!cfg.featureEnabled || !cfg.brainConfigured) return null;
  if (cfg.provider === 'anthropic') {
    return new AnthropicProvider({
      apiKey: cfg.apiKey!,
      model: cfg.model,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
  }
  return new OpenAiCompatibleProvider({
    baseUrl: cfg.baseUrl!,
    model: cfg.model,
    apiKey: cfg.apiKey,
    requestTimeoutMs: cfg.requestTimeoutMs,
  });
}
