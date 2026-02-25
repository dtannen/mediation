import path from 'node:path';
import { appendFile, mkdir } from 'node:fs/promises';

export async function appendOrchestrationAudit(
  auditPath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
}

export function toReadySessionResult(deviceId: string, status: Record<string, unknown> | null): {
  ok: true;
  deviceId: string;
  sessionId: string | null;
  conversationId: string | null;
} {
  return {
    ok: true,
    deviceId,
    sessionId: typeof status?.sessionId === 'string' ? status.sessionId : null,
    conversationId: typeof status?.conversationId === 'string' ? status.conversationId : null,
  };
}

export async function waitForRemoteSessionReady(
  getStatus: (deviceId: string) => Record<string, unknown> | null,
  deviceId: string,
  timeoutMs = 45_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = getStatus(deviceId);
    if (status?.status === 'ready') {
      return status;
    }
    if (!status || status.status !== 'handshaking') {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}
