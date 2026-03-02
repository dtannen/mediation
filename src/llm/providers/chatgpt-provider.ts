import type { ProviderPlugin, ProviderRunInput, ProviderRunResult } from '../provider';

/**
 * ChatGPT / OpenAI provider plugin (Spec Section 5.4).
 *
 * V2 mandates ChatGPT as the runtime default model family for all three
 * AI roles (intake, draft coach, mediator).
 *
 * Configuration:
 *   OPENAI_API_KEY — required for API calls
 *   OPENAI_BASE_URL — optional base URL override (default: https://api.openai.com/v1)
 */

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  model?: string;
}

async function runChatGPTPrompt(input: ProviderRunInput): Promise<ProviderRunResult> {
  const apiKey = input.providerConfig.OPENAI_API_KEY
    || process.env.OPENAI_API_KEY
    || '';

  const baseUrl = (
    input.providerConfig.OPENAI_BASE_URL
    || process.env.OPENAI_BASE_URL
    || 'https://api.openai.com/v1'
  ).replace(/\/$/, '');

  if (!apiKey) {
    throw new Error(
      'chatgpt_provider: OPENAI_API_KEY is not set. '
      + 'Set the OPENAI_API_KEY environment variable or configure it in provider settings.',
    );
  }

  const messages: Array<{ role: string; content: string }> = [];

  if (input.systemPrompt) {
    messages.push({ role: 'system', content: input.systemPrompt });
  }

  messages.push({ role: 'user', content: input.prompt });

  const payload = {
    model: input.model || 'gpt-4o',
    messages,
    max_tokens: 4096,
  };

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`chatgpt_provider_failed_http_${resp.status}: ${text.slice(0, 300)}`);
  }

  const parsed = await resp.json() as ChatCompletionResponse;
  const content = parsed.choices?.[0]?.message?.content || '';
  const totalTokens = parsed.usage?.total_tokens || 0;

  // Rough cost estimate for gpt-4o: ~$5/1M input + $15/1M output tokens
  const promptTokens = parsed.usage?.prompt_tokens || 0;
  const completionTokens = parsed.usage?.completion_tokens || 0;
  const costUsd = (promptTokens * 5 + completionTokens * 15) / 1_000_000;

  return {
    result: content.trim(),
    turns: 1,
    costUsd,
    model: parsed.model || input.model,
    sessionId: input.resumeSessionId,
  };
}

const chatgptProvider: ProviderPlugin = {
  id: 'chatgpt',
  name: 'ChatGPT',
  defaultModel: 'gpt-4o',
  capabilities: {
    supportsTools: false,
    supportsSessionResume: false,
    supportsPolicy: false,
    contextWindowTokens: 128_000, // gpt-4o context window
  },
  runPrompt: runChatGPTPrompt,
};

export default chatgptProvider;
