import { requireConfig } from '../config';
import { registerBuiltInProviders } from '../llm/providers';
import { startLocalPromptBridge } from '../llm/local-prompt-bridge';

export async function startMediationRuntime(): Promise<() => void> {
  const config = await requireConfig();
  registerBuiltInProviders();

  const stopBridge = startLocalPromptBridge({
    profileId: config.deviceId,
    defaultCwd: process.cwd(),
    provider: config.provider || 'claude',
    model: config.model || 'sonnet',
  });

  return () => {
    stopBridge();
  };
}
