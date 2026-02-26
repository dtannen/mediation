import { createHash } from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { MediationResult } from './protocol';

interface IdempotencyRecord {
  grantId: string;
  key: string;
  fingerprint: string;
  completedAtMs: number;
  response: MediationResult;
}

interface PersistedPayload {
  version: 1;
  updatedAt: string;
  records: IdempotencyRecord[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function cloneResult(result: MediationResult): MediationResult {
  return JSON.parse(JSON.stringify(result)) as MediationResult;
}

function storageKey(grantId: string, key: string): string {
  return `${grantId}::${key}`;
}

export function commandFingerprint(input: {
  command: string;
  caseId?: string;
  partyId?: string;
  payload: Record<string, unknown>;
}): string {
  const payloadWithoutIdem: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.payload || {})) {
    if (key === 'idempotency_key') {
      continue;
    }
    payloadWithoutIdem[key] = value;
  }

  const material = canonicalize({
    command: input.command,
    case_id: input.caseId ?? null,
    party_id: input.partyId ?? null,
    payload: payloadWithoutIdem,
  });
  return createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex');
}

export class IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(
    private readonly storagePath: string,
    private readonly ttlMs = 15 * 60 * 1000,
  ) {
    this.load();
  }

  get(grantId: string, key: string, fingerprint: string): {
    hit: true;
    response: MediationResult;
    replayed: true;
  } | {
    hit: false;
  } | {
    conflict: true;
  } {
    this.pruneExpired();
    const record = this.records.get(storageKey(grantId, key));
    if (!record) {
      return { hit: false };
    }
    if (record.fingerprint !== fingerprint) {
      return { conflict: true };
    }
    return {
      hit: true,
      replayed: true,
      response: cloneResult(record.response),
    };
  }

  set(grantId: string, key: string, fingerprint: string, response: MediationResult): void {
    const record: IdempotencyRecord = {
      grantId,
      key,
      fingerprint,
      completedAtMs: Date.now(),
      response: cloneResult(response),
    };
    this.records.set(storageKey(grantId, key), record);
    this.pruneExpired();
    this.flush();
  }

  private load(): void {
    if (!existsSync(this.storagePath)) {
      return;
    }
    try {
      const raw = readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedPayload>;
      if (!Array.isArray(parsed.records)) {
        return;
      }
      for (const record of parsed.records) {
        if (!record || typeof record !== 'object') {
          continue;
        }
        const key = storageKey(String(record.grantId || ''), String(record.key || ''));
        if (!key || key === '::') {
          continue;
        }
        const completedAtMs = Number(record.completedAtMs);
        if (!Number.isFinite(completedAtMs) || completedAtMs <= 0) {
          continue;
        }
        if (!record.response || typeof record.response !== 'object') {
          continue;
        }
        this.records.set(key, {
          grantId: String(record.grantId || ''),
          key: String(record.key || ''),
          fingerprint: String(record.fingerprint || ''),
          completedAtMs,
          response: cloneResult(record.response as MediationResult),
        });
      }
      this.pruneExpired();
    } catch {
      // best effort
    }
  }

  private pruneExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, record] of this.records.entries()) {
      if (record.completedAtMs < cutoff) {
        this.records.delete(key);
      }
    }
  }

  private flush(): void {
    try {
      mkdirSync(path.dirname(this.storagePath), { recursive: true });
      const payload: PersistedPayload = {
        version: 1,
        updatedAt: new Date().toISOString(),
        records: [...this.records.values()].map((record) => ({
          ...record,
          response: cloneResult(record.response),
        })),
      };
      const tmpPath = `${this.storagePath}.tmp.${Date.now()}`;
      writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      renameSync(tmpPath, this.storagePath);
    } catch {
      // best effort
    }
  }
}

