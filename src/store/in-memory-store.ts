import type { MediationCase } from '../domain/types';

export class InMemoryMediationStore {
  private readonly cases = new Map<string, MediationCase>();

  save(mediationCase: MediationCase): void {
    this.cases.set(mediationCase.id, mediationCase);
  }

  get(caseId: string): MediationCase | undefined {
    return this.cases.get(caseId);
  }

  list(): MediationCase[] {
    return [...this.cases.values()];
  }

  clear(): void {
    this.cases.clear();
  }

  delete(caseId: string): void {
    this.cases.delete(caseId);
  }
}
