import type { ProviderPlugin, ProviderRunInput, ProviderRunResult } from '../provider';

interface OllamaGenerateResponse {
  response?: string;
}

async function runOllamaPrompt(input: ProviderRunInput): Promise<ProviderRunResult> {
  const baseUrl = input.providerConfig.OLLAMA_BASE_URL
    || process.env.OLLAMA_BASE_URL
    || 'http://localhost:11434';

  const payload = {
    model: input.model,
    prompt: input.prompt,
    stream: false,
    options: {
      num_ctx: 8192,
    },
  };

  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`ollama_provider_failed_http_${resp.status}: ${text.slice(0, 300)}`);
  }

  const parsed = await resp.json() as OllamaGenerateResponse;
  return {
    result: typeof parsed.response === 'string' ? parsed.response.trim() : '',
    turns: 1,
    costUsd: 0,
    model: input.model,
    sessionId: input.resumeSessionId,
  };
}

const ollamaProvider: ProviderPlugin = {
  id: 'ollama',
  name: 'Ollama',
  defaultModel: 'llama3.2',
  capabilities: {
    supportsTools: false,
    supportsSessionResume: true,
    supportsPolicy: false,
  },
  runPrompt: runOllamaPrompt,
};

export default ollamaProvider;
