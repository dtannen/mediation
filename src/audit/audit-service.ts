import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import type { MediationPhase } from '../domain/types';

export interface AuditEvent {
  event_id: string;
  ts: string;
  case_id: string;
  phase: MediationPhase;
  actor_type: string;
  actor_id: string;
  event_type: string;
  policy_decision?: string;
  delivery_mode?: string;
  error?: string;
}

const ensured = new Set<string>();

async function ensureAuditPath(filePath: string): Promise<void> {
  if (ensured.has(filePath)) {
    return;
  }

  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700).catch(() => undefined);

  await appendFile(filePath, '', { encoding: 'utf8', mode: 0o600, flag: 'a' });
  await chmod(filePath, 0o600).catch(() => undefined);

  ensured.add(filePath);
}

export async function appendAuditEvent(filePath: string, event: AuditEvent): Promise<void> {
  await ensureAuditPath(filePath);
  await appendFile(filePath, `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'a',
  });
}

export function createAuditEvent(input: Omit<AuditEvent, 'event_id' | 'ts'>): AuditEvent {
  return {
    event_id: `evt_${randomUUID()}`,
    ts: new Date().toISOString(),
    ...input,
  };
}
