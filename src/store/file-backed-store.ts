import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import type { MediationCase } from '../domain/types';
import { InMemoryMediationStore } from './in-memory-store';

interface StoredCasesPayload {
  version: 1;
  cases: MediationCase[];
  updatedAt: string;
}

function isMediationCase(value: unknown): value is MediationCase {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && record.id.trim().length > 0;
}

export class FileBackedMediationStore extends InMemoryMediationStore {
  constructor(private readonly storagePath: string) {
    super();
    this.loadFromDisk();
  }

  override save(mediationCase: MediationCase): void {
    super.save(mediationCase);
    this.flushToDisk();
  }

  override clear(): void {
    super.clear();
    this.flushToDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.storagePath)) {
      return;
    }

    try {
      const raw = readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredCasesPayload>;
      const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
      for (const mediationCase of cases) {
        if (isMediationCase(mediationCase)) {
          super.save(mediationCase);
        }
      }
    } catch {
      // best-effort load; continue with empty store on parse/read failure
    }
  }

  private flushToDisk(): void {
    try {
      mkdirSync(path.dirname(this.storagePath), { recursive: true });
      const payload: StoredCasesPayload = {
        version: 1,
        cases: super.list(),
        updatedAt: new Date().toISOString(),
      };
      const tmpPath = `${this.storagePath}.tmp.${Date.now()}`;
      writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      renameSync(tmpPath, this.storagePath);
    } catch {
      // best-effort persistence
    }
  }
}
