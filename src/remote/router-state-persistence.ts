import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { PersistedRouterState, RouterStatePersistence } from './router';

interface PersistedPayload {
  version: 1;
  state: PersistedRouterState;
}

export class FileBackedRouterStatePersistence implements RouterStatePersistence {
  constructor(private readonly storagePath: string) {}

  load(): PersistedRouterState | null {
    if (!existsSync(this.storagePath)) {
      return null;
    }

    try {
      const raw = readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedPayload>;
      if (parsed.version !== 1 || !parsed.state) {
        return null;
      }
      return parsed.state;
    } catch {
      // best-effort load; continue with empty state on parse/read failure
      return null;
    }
  }

  save(state: PersistedRouterState): void {
    try {
      mkdirSync(path.dirname(this.storagePath), { recursive: true });
      const payload: PersistedPayload = {
        version: 1,
        state,
      };
      const tmpPath = `${this.storagePath}.tmp.${Date.now()}`;
      writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      renameSync(tmpPath, this.storagePath);
    } catch {
      // best-effort persistence
    }
  }
}
