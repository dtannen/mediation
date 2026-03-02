import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  CoachingCategory,
  CoachingTemplate,
  CoachingTemplateVersion,
  CoachingRole,
  TemplateStatus,
} from '../domain/types';

interface StoredTemplatePayload {
  version: 1;
  categories: CoachingCategory[];
  templates: CoachingTemplate[];
  templateVersions: CoachingTemplateVersion[];
  updatedAt: string;
}

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const DEFAULT_PREAMBLES: Record<CoachingRole, string> = {
  intake: 'You are a private intake coach helping a mediation party articulate their perspective.',
  draft_coach: 'You are a draft coach helping a mediation party compose thoughtful messages for group discussion.',
  mediator: 'You are a neutral AI mediator facilitating constructive dialogue between parties.',
};

const DEFAULT_INSTRUCTIONS: Record<CoachingRole, string> = {
  intake: 'Guide the party through structured questions to understand their position, interests, and constraints.',
  draft_coach: 'Help the party refine their message for clarity, empathy, and constructiveness.',
  mediator: 'Facilitate balanced discussion, ask clarifying questions, and help identify common ground.',
};

export class FileBackedTemplateStore {
  private readonly categories = new Map<string, CoachingCategory>();
  private readonly templates = new Map<string, CoachingTemplate>();
  private readonly versions = new Map<string, CoachingTemplateVersion>();

  constructor(private readonly storagePath: string) {
    this.loadFromDisk();
    this.migrateVersionsToV2();
    this.seedDefaults();
  }

  listCategories(): CoachingCategory[] {
    return [...this.categories.values()];
  }

  getCategory(categoryId: string): CoachingCategory | undefined {
    return this.categories.get(categoryId);
  }

  saveCategory(category: CoachingCategory): void {
    this.categories.set(category.id, category);
    this.flushToDisk();
  }

  deleteCategory(categoryId: string): boolean {
    const deleted = this.categories.delete(categoryId);
    if (deleted) this.flushToDisk();
    return deleted;
  }

  /** Returns true if any non-deleted templates reference this category */
  isCategoryInUse(categoryId: string): boolean {
    for (const t of this.templates.values()) {
      if (!t.deletedAt && t.categoryId === categoryId) return true;
    }
    return false;
  }

  listTemplates(categoryId?: string, opts?: { includeDeleted?: boolean }): CoachingTemplate[] {
    let all = [...this.templates.values()];
    // Filter out soft-deleted templates unless explicitly requested
    if (!opts?.includeDeleted) {
      all = all.filter((t) => !t.deletedAt);
    }
    if (categoryId) {
      return all.filter((t) => t.categoryId === categoryId);
    }
    return all;
  }

  getTemplate(templateId: string): CoachingTemplate | undefined {
    return this.templates.get(templateId);
  }

  saveTemplate(template: CoachingTemplate): void {
    this.templates.set(template.id, template);
    this.flushToDisk();
  }

  /**
   * Soft-delete a template by setting `deletedAt` marker.
   * Versions are preserved for pinned-case resolution (F-03/F-05).
   */
  softDeleteTemplate(templateId: string): string {
    const template = this.templates.get(templateId);
    if (!template) return '';
    const now = nowIso();
    template.deletedAt = now;
    template.updatedAt = now;
    this.templates.set(templateId, template);
    this.flushToDisk();
    return now;
  }

  /** @deprecated Hard delete — use softDeleteTemplate for v2 compliance */
  deleteTemplate(templateId: string): void {
    this.softDeleteTemplate(templateId);
  }

  getTemplateVersion(versionId: string): CoachingTemplateVersion | undefined {
    return this.versions.get(versionId);
  }

  getLatestVersion(templateId: string): CoachingTemplateVersion | undefined {
    let latest: CoachingTemplateVersion | undefined;
    for (const version of this.versions.values()) {
      if (version.templateId !== templateId) continue;
      if (!latest || version.versionNumber > latest.versionNumber) {
        latest = version;
      }
    }
    return latest;
  }

  listVersions(templateId: string): CoachingTemplateVersion[] {
    return [...this.versions.values()]
      .filter((v) => v.templateId === templateId)
      .sort((a, b) => b.versionNumber - a.versionNumber);
  }

  saveVersion(version: CoachingTemplateVersion): void {
    this.versions.set(version.id, version);
    this.flushToDisk();
  }

  private seedDefaults(): void {
    if (this.categories.size > 0) return;

    const categoryId = makeId('cat');
    const now = nowIso();

    const category: CoachingCategory = {
      id: categoryId,
      name: 'General',
      description: 'General-purpose mediation templates',
      createdAt: now,
      updatedAt: now,
    };

    const templateId = makeId('tpl');
    const versionId = makeId('tplv');

    // Seed with full v2 fields (Section 4.3)
    const version: CoachingTemplateVersion = {
      id: versionId,
      templateId,
      versionNumber: 1,
      // V2 spec fields
      globalGuidance: 'Maintain a neutral, supportive tone. Prioritize understanding over judgment.',
      intakeCoachPreamble: DEFAULT_PREAMBLES.intake,
      draftCoachPreamble: DEFAULT_PREAMBLES.draft_coach,
      mediatorPreamble: DEFAULT_PREAMBLES.mediator,
      intakeCoachInstructions: DEFAULT_INSTRUCTIONS.intake,
      draftCoachInstructions: DEFAULT_INSTRUCTIONS.draft_coach,
      mediatorInstructions: DEFAULT_INSTRUCTIONS.mediator,
      changeNote: 'Initial system default version',
      createdByActorId: 'system',
      // Legacy compat fields
      preambles: { ...DEFAULT_PREAMBLES },
      instructions: { ...DEFAULT_INSTRUCTIONS },
      changeNotes: 'Initial system default version',
      actorId: 'system',
      createdAt: now,
    };

    const template: CoachingTemplate = {
      id: templateId,
      categoryId,
      name: 'General Mediation',
      description: 'Default template for general mediation cases',
      status: 'active',
      currentVersion: 1,
      currentVersionId: versionId,
      createdAt: now,
      updatedAt: now,
    };

    this.categories.set(categoryId, category);
    this.templates.set(templateId, template);
    this.versions.set(versionId, version);
    this.flushToDisk();
  }

  /**
   * Backfill existing template versions to guaranteed v2 shape (c3_0 fix).
   * Ensures all stored versions have required globalGuidance, changeNote,
   * createdByActorId, and individual role preamble/instruction fields.
   */
  private migrateVersionsToV2(): void {
    let dirty = false;
    for (const [id, version] of this.versions) {
      const ver = version as unknown as Record<string, unknown>;
      let changed = false;

      // Backfill globalGuidance
      if (typeof ver.globalGuidance !== 'string') {
        (ver as any).globalGuidance = '';
        changed = true;
      }
      // Backfill changeNote from legacy changeNotes
      if (typeof ver.changeNote !== 'string') {
        (ver as any).changeNote = typeof ver.changeNotes === 'string' ? ver.changeNotes : '';
        changed = true;
      }
      // Backfill createdByActorId from legacy actorId
      if (typeof ver.createdByActorId !== 'string') {
        (ver as any).createdByActorId = typeof ver.actorId === 'string' ? ver.actorId : 'system';
        changed = true;
      }
      // Backfill individual role preamble fields from legacy preambles map
      const preambles = (ver.preambles && typeof ver.preambles === 'object')
        ? ver.preambles as Record<string, string> : {};
      const instructions = (ver.instructions && typeof ver.instructions === 'object')
        ? ver.instructions as Record<string, string> : {};
      for (const [roleKey, field] of [
        ['intake', 'intakeCoachPreamble'],
        ['draft_coach', 'draftCoachPreamble'],
        ['mediator', 'mediatorPreamble'],
      ] as const) {
        if (typeof ver[field] !== 'string') {
          (ver as any)[field] = preambles[roleKey] || '';
          changed = true;
        }
      }
      for (const [roleKey, field] of [
        ['intake', 'intakeCoachInstructions'],
        ['draft_coach', 'draftCoachInstructions'],
        ['mediator', 'mediatorInstructions'],
      ] as const) {
        if (typeof ver[field] !== 'string') {
          (ver as any)[field] = instructions[roleKey] || '';
          changed = true;
        }
      }
      if (changed) {
        this.versions.set(id, ver as unknown as CoachingTemplateVersion);
        dirty = true;
      }
    }
    if (dirty) {
      this.flushToDisk();
    }
  }

  private loadFromDisk(): void {
    if (!existsSync(this.storagePath)) return;

    try {
      const raw = readFileSync(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredTemplatePayload>;

      if (Array.isArray(parsed.categories)) {
        for (const cat of parsed.categories) {
          if (cat && typeof cat === 'object' && typeof cat.id === 'string') {
            this.categories.set(cat.id, cat as CoachingCategory);
          }
        }
      }

      if (Array.isArray(parsed.templates)) {
        for (const tpl of parsed.templates) {
          if (tpl && typeof tpl === 'object' && typeof tpl.id === 'string') {
            this.templates.set(tpl.id, tpl as CoachingTemplate);
          }
        }
      }

      if (Array.isArray(parsed.templateVersions)) {
        for (const ver of parsed.templateVersions) {
          if (ver && typeof ver === 'object' && typeof ver.id === 'string') {
            this.versions.set(ver.id, ver as CoachingTemplateVersion);
          }
        }
      }
    } catch {
      // best-effort load
    }
  }

  private flushToDisk(): void {
    try {
      mkdirSync(path.dirname(this.storagePath), { recursive: true });
      const payload: StoredTemplatePayload = {
        version: 1,
        categories: [...this.categories.values()],
        templates: [...this.templates.values()],
        templateVersions: [...this.versions.values()],
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
