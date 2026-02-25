import type { ProviderPlugin, ProviderRunInput, ProviderRunResult } from '../provider';
import { runClaudeSdkPrompt } from '../claude';

async function runClaudePrompt(input: ProviderRunInput): Promise<ProviderRunResult> {
  return runClaudeSdkPrompt(input);
}

const claudeProvider: ProviderPlugin = {
  id: 'claude',
  name: 'Claude',
  defaultModel: 'sonnet',
  capabilities: {
    supportsTools: true,
    supportsSessionResume: true,
    supportsPolicy: true,
  },
  runPrompt: runClaudePrompt,
};

export default claudeProvider;
