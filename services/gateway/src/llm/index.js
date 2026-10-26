/**
 * Chooses the chat model adapter from configuration (anthropic, openai-compatible, mock or none).
 */
import { anthropicAdapter } from './anthropic.js';
import { openaiAdapter } from './openai.js';
import { mockAdapter } from './mock.js';

/** Returns { provider, model, configured, reason, complete() } for the configured LLM. */
export function createLlm(llm) {
  const timeoutMs = llm.timeoutMs;
  const base = { provider: llm.provider, model: llm.model };
  if (llm.provider === 'mock') return { ...base, model: 'mock', configured: true, ...mockAdapter() };
  if (llm.provider === 'none' || !llm.provider) {
    return {
      ...base,
      configured: false,
      reason: 'No language model is configured (set llm.provider in the Helm values).',
      complete: async () => {
        throw new Error('LLM not configured');
      },
    };
  }
  if (!['anthropic', 'openai'].includes(llm.provider)) {
    return {
      ...base,
      configured: false,
      reason: `Unknown LLM provider "${llm.provider}" (use anthropic, openai or mock).`,
      complete: async () => {
        throw new Error('LLM not configured');
      },
    };
  }
  const isLocalOpenAi = llm.provider === 'openai' && llm.baseUrl && !llm.apiKey; // e.g. Ollama needs no key
  if (!llm.model)
    return {
      ...base,
      configured: false,
      reason: 'llm.model is not set.',
      complete: async () => {
        throw new Error('LLM not configured');
      },
    };
  if (!llm.apiKey && !isLocalOpenAi) {
    return {
      ...base,
      configured: false,
      reason: 'No LLM API key found. Provide it as a Kubernetes Secret (see README: LLM_API_KEY).',
      complete: async () => {
        throw new Error('LLM not configured');
      },
    };
  }
  const adapter =
    llm.provider === 'anthropic'
      ? anthropicAdapter({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, timeoutMs })
      : openaiAdapter({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, timeoutMs });
  return { ...base, configured: true, ...adapter };
}
