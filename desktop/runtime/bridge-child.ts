import { registerBuiltInProviders } from '../../src/llm/providers';
import { startLocalPromptBridge } from '../../src/llm/local-prompt-bridge';

// Gracefully handle EPIPE errors (broken pipe) instead of crashing.
function handleEpipe(err: NodeJS.ErrnoException): void {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
}
process.stdout.on('error', handleEpipe);
process.stderr.on('error', handleEpipe);

function pickEnv(name: string, fallback: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }
  return value.trim();
}

async function main(): Promise<void> {
  const profileId = pickEnv('MEDIATION_BRIDGE_PROFILE_ID', 'default');
  const provider = pickEnv('MEDIATION_BRIDGE_PROVIDER', 'claude');
  const model = pickEnv('MEDIATION_BRIDGE_MODEL', 'sonnet');
  const defaultCwd = pickEnv('MEDIATION_BRIDGE_CWD', process.cwd());

  registerBuiltInProviders();

  const stopBridge = startLocalPromptBridge({
    profileId,
    provider,
    model,
    defaultCwd,
  });

  const shutdown = (): void => {
    try {
      stopBridge();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[bridge-child] ${message}\n`);
  process.exit(1);
});

