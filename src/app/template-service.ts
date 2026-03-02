import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors';
import type {
  CoachingCategory,
  CoachingTemplate,
  CoachingTemplateVersion,
  CoachingRole,
  TemplateStatus,
} from '../domain/types';
import type { FileBackedTemplateStore } from '../store/template-store';

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TemplateService {
  constructor(private readonly store: FileBackedTemplateStore) {}

  listCategories(): CoachingCategory[] {
    return this.store.listCategories();
  }

  createCategory(input: { name: string; description?: string }): CoachingCategory {
    const name = (input.name || '').trim();
    if (!name) throw new DomainError('invalid_payload', 'Category name is required');
    const category: CoachingCategory = {
      id: makeId('cat'),
      name,
      description: (input.description || '').trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.saveCategory(category);
    return category;
  }

  updateCategory(categoryId: string, input: { name?: string; description?: string }): CoachingCategory {
    const existing = this.store.getCategory(categoryId);
    if (!existing) throw new DomainError('category_not_found', `Category '${categoryId}' not found`);
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new DomainError('invalid_payload', 'Category name cannot be empty');
      existing.name = name;
    }
    if (input.description !== undefined) {
      existing.description = input.description.trim();
    }
    existing.updatedAt = nowIso();
    this.store.saveCategory(existing);
    return existing;
  }

  deleteCategory(categoryId: string): { categoryId: string; deletedAt: string } {
    const existing = this.store.getCategory(categoryId);
    if (!existing) throw new DomainError('category_not_found', `Category '${categoryId}' not found`);
    if (this.store.isCategoryInUse(categoryId)) {
      throw new DomainError('category_in_use', 'Cannot delete category: templates still reference it');
    }
    this.store.deleteCategory(categoryId);
    return { categoryId, deletedAt: nowIso() };
  }

  getTemplate(templateId: string): CoachingTemplate {
    const template = this.store.getTemplate(templateId);
    if (!template) {
      throw new DomainError('template_not_found', `template '${templateId}' not found`);
    }
    return template;
  }

  createTemplate(input: {
    categoryId: string;
    name: string;
    description?: string;
    // V2 spec fields (Section 4.3 / 7.1 CreateTemplateRequest)
    globalGuidance?: string;
    intakeCoachPreamble?: string;
    draftCoachPreamble?: string;
    mediatorPreamble?: string;
    intakeCoachInstructions?: string;
    draftCoachInstructions?: string;
    mediatorInstructions?: string;
    changeNote?: string;
    // Legacy fields (backward compat)
    preambles?: Record<CoachingRole, string>;
    instructions?: Record<CoachingRole, string>;
    actorId: string;
  }): { template: CoachingTemplate; version: CoachingTemplateVersion } {
    const category = this.store.getCategory(input.categoryId);
    if (!category) {
      throw new DomainError('template_not_found', `category '${input.categoryId}' not found`);
    }

    const name = input.name.trim();
    if (!name) {
      throw new DomainError('invalid_topic', 'template name is required');
    }

    const now = nowIso();
    const templateId = makeId('tpl');
    const versionId = makeId('tplv');

    // Resolve role preambles: v2 individual fields > legacy preambles map
    const intakeCoachPreamble = input.intakeCoachPreamble || input.preambles?.intake || '';
    const draftCoachPreamble = input.draftCoachPreamble || input.preambles?.draft_coach || '';
    const mediatorPreamble = input.mediatorPreamble || input.preambles?.mediator || '';
    const intakeCoachInstructions = input.intakeCoachInstructions || input.instructions?.intake || '';
    const draftCoachInstructions = input.draftCoachInstructions || input.instructions?.draft_coach || '';
    const mediatorInstructions = input.mediatorInstructions || input.instructions?.mediator || '';

    const version: CoachingTemplateVersion = {
      id: versionId,
      templateId,
      versionNumber: 1,
      globalGuidance: (input.globalGuidance || '').trim(),
      intakeCoachPreamble,
      draftCoachPreamble,
      mediatorPreamble,
      intakeCoachInstructions,
      draftCoachInstructions,
      mediatorInstructions,
      changeNote: (input.changeNote || 'Initial version').trim(),
      createdByActorId: input.actorId,
      // Legacy compat: keep preambles/instructions maps populated
      preambles: { intake: intakeCoachPreamble, draft_coach: draftCoachPreamble, mediator: mediatorPreamble },
      instructions: { intake: intakeCoachInstructions, draft_coach: draftCoachInstructions, mediator: mediatorInstructions },
      changeNotes: (input.changeNote || 'Initial version').trim(),
      actorId: input.actorId,
      createdAt: now,
    };

    const template: CoachingTemplate = {
      id: templateId,
      categoryId: input.categoryId,
      name,
      description: (input.description || '').trim(),
      status: 'active',
      currentVersionId: versionId,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.store.saveVersion(version);
    this.store.saveTemplate(template);

    return { template, version };
  }

  updateTemplateMeta(templateId: string, input: {
    name?: string;
    description?: string;
    categoryId?: string;
  }): CoachingTemplate {
    const template = this.getTemplate(templateId);

    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new DomainError('invalid_topic', 'template name cannot be empty');
      template.name = name;
    }

    if (input.description !== undefined) {
      template.description = input.description.trim();
    }

    if (input.categoryId !== undefined) {
      const category = this.store.getCategory(input.categoryId);
      if (!category) throw new DomainError('template_not_found', `category '${input.categoryId}' not found`);
      template.categoryId = input.categoryId;
    }

    template.updatedAt = nowIso();
    this.store.saveTemplate(template);
    return template;
  }

  setTemplateStatus(templateId: string, status: TemplateStatus): CoachingTemplate {
    const template = this.getTemplate(templateId);
    template.status = status;
    template.updatedAt = nowIso();
    this.store.saveTemplate(template);
    return template;
  }

  /**
   * Soft-delete a template (F-03/F-05).
   * Active (non-closed) cases referencing this template keep their pinned version.
   */
  deleteTemplate(
    templateId: string,
    caseStore?: { list(): Array<{ templateSelection?: { templateId: string }; phase?: string }> },
  ): { templateId: string; deletedAt: string } {
    const template = this.getTemplate(templateId);

    // Block if in active use by non-closed cases
    if (caseStore) {
      const inUse = caseStore.list().some(
        (c) => c.templateSelection?.templateId === templateId && c.phase !== 'closed',
      );
      if (inUse) {
        throw new DomainError('template_in_use', `template '${templateId}' is in use by one or more active cases`);
      }
    }

    const deletedAt = this.store.softDeleteTemplate(templateId);
    return { templateId, deletedAt };
  }

  listTemplates(categoryId?: string, opts?: { includeArchived?: boolean }): CoachingTemplate[] {
    return this.store.listTemplates(categoryId);
  }

  /**
   * Resolve template + version for a case.
   * When templateVersion is provided, resolve the exact pinned version (F-03 rule 4).
   * Does NOT silently fall back to current version when a specific pin is requested
   * but cannot be resolved — throws instead so callers know the pin is stale.
   */
  resolveTemplateForCase(
    templateId?: string,
    templateVersion?: number,
  ): { template: CoachingTemplate; version: CoachingTemplateVersion } {
    if (templateId) {
      const template = this.store.getTemplate(templateId);
      if (template) {
        // Resolve exact pinned version when specified (c2_4 fix: no silent fallback)
        if (typeof templateVersion === 'number' && templateVersion > 0) {
          const versions = this.store.listVersions(templateId);
          const pinned = versions.find((v) => v.versionNumber === templateVersion);
          if (pinned) return { template, version: pinned };
          // Pinned version not found — throw so callers know the pin is stale
          throw new DomainError(
            'template_version_not_found',
            `Pinned version ${templateVersion} not found for template '${templateId}'. Pin may be stale.`,
          );
        }
        // No specific version pin — use current version
        const version = this.store.getTemplateVersion(template.currentVersionId);
        if (version) return { template, version };
      }
    }
    return this.getSystemDefault();
  }

  /**
   * Strict template+version existence check (c4_1).
   * Unlike resolveTemplateForCase, this does NOT fall back to system default.
   * Returns true only if the exact templateId exists AND the exact versionNumber
   * is present. Used for route-gating validation of pinned selections.
   */
  isTemplateVersionResolvable(templateId: string, templateVersion: number): boolean {
    if (!templateId) return false;
    const template = this.store.getTemplate(templateId);
    if (!template) return false;
    if (typeof templateVersion !== 'number' || templateVersion <= 0) return false;
    const versions = this.store.listVersions(templateId);
    return versions.some((v) => v.versionNumber === templateVersion);
  }

  /**
   * Map a legacy versionId to its versionNumber.
   * Used during migration to deterministically resolve pinned versions.
   */
  resolveVersionIdToNumber(templateId: string, versionId: string): number | undefined {
    const versions = this.store.listVersions(templateId);
    const found = versions.find((v) => v.id === versionId);
    return found?.versionNumber;
  }

  /**
   * List all versions for a template (for admin UI).
   */
  listVersions(templateId: string): CoachingTemplateVersion[] {
    return this.store.listVersions(templateId);
  }

  /**
   * Get a specific template version by number.
   */
  getTemplateVersion(templateId: string, versionNumber: number): CoachingTemplateVersion | undefined {
    const versions = this.store.listVersions(templateId);
    return versions.find((v) => v.versionNumber === versionNumber);
  }

  getTemplateWithVersion(
    templateId: string,
    version?: number,
  ): { template: CoachingTemplate; version: CoachingTemplateVersion } {
    const template = this.getTemplate(templateId);
    if (typeof version === 'number') {
      const versions = this.store.listVersions(templateId);
      const found = versions.find((v) => v.versionNumber === version);
      if (!found) {
        throw new DomainError('template_version_not_found', `version ${version} not found for template '${templateId}'`);
      }
      return { template, version: found };
    }
    const currentVersion = this.store.getTemplateVersion(template.currentVersionId);
    if (!currentVersion) {
      throw new DomainError('template_not_found', `version '${template.currentVersionId}' not found for template '${templateId}'`);
    }
    return { template, version: currentVersion };
  }

  /**
   * Create a new version, optionally restoring content from a prior version (F-05).
   * Supports both v2 spec individual fields and legacy preambles/instructions maps.
   */
  createVersion(templateId: string, input: {
    preambles?: Record<CoachingRole, string>;
    instructions?: Record<CoachingRole, string>;
    globalGuidance?: string;
    intakeCoachPreamble?: string;
    draftCoachPreamble?: string;
    mediatorPreamble?: string;
    intakeCoachInstructions?: string;
    draftCoachInstructions?: string;
    mediatorInstructions?: string;
    changeNotes?: string;
    changeNote?: string;
    actorId: string;
    restoreFromVersion?: number;
  }): { version: CoachingTemplateVersion; template: CoachingTemplate } {
    const template = this.getTemplate(templateId);
    const versions = this.store.listVersions(templateId);
    const nextNumber = versions.length > 0 ? versions[0].versionNumber + 1 : 1;

    // If restoreFromVersion is set, copy content from that version (F-05 restore)
    let sourceVersion: CoachingTemplateVersion | undefined;
    if (typeof input.restoreFromVersion === 'number') {
      sourceVersion = versions.find((v) => v.versionNumber === input.restoreFromVersion);
      if (!sourceVersion) {
        throw new DomainError('template_version_not_found', `version ${input.restoreFromVersion} not found`);
      }
    }

    // Resolve v2 individual role fields: explicit input > restored source > legacy maps > empty
    const intakeCoachPreamble = input.intakeCoachPreamble || sourceVersion?.intakeCoachPreamble || input.preambles?.intake || sourceVersion?.preambles?.intake || '';
    const draftCoachPreamble = input.draftCoachPreamble || sourceVersion?.draftCoachPreamble || input.preambles?.draft_coach || sourceVersion?.preambles?.draft_coach || '';
    const mediatorPreamble = input.mediatorPreamble || sourceVersion?.mediatorPreamble || input.preambles?.mediator || sourceVersion?.preambles?.mediator || '';
    const intakeCoachInstructions = input.intakeCoachInstructions || sourceVersion?.intakeCoachInstructions || input.instructions?.intake || sourceVersion?.instructions?.intake || '';
    const draftCoachInstructions = input.draftCoachInstructions || sourceVersion?.draftCoachInstructions || input.instructions?.draft_coach || sourceVersion?.instructions?.draft_coach || '';
    const mediatorInstructions = input.mediatorInstructions || sourceVersion?.mediatorInstructions || input.instructions?.mediator || sourceVersion?.instructions?.mediator || '';
    const globalGuidance = input.globalGuidance ?? sourceVersion?.globalGuidance ?? '';

    const changeNote = (input.changeNote || input.changeNotes || '').trim();

    const versionId = makeId('tplv');
    const version: CoachingTemplateVersion = {
      id: versionId,
      templateId,
      versionNumber: nextNumber,
      // V2 spec fields (Section 4.3)
      globalGuidance,
      intakeCoachPreamble,
      draftCoachPreamble,
      mediatorPreamble,
      intakeCoachInstructions,
      draftCoachInstructions,
      mediatorInstructions,
      changeNote,
      createdByActorId: input.actorId,
      // Legacy compat
      preambles: { intake: intakeCoachPreamble, draft_coach: draftCoachPreamble, mediator: mediatorPreamble },
      instructions: { intake: intakeCoachInstructions, draft_coach: draftCoachInstructions, mediator: mediatorInstructions },
      changeNotes: changeNote,
      actorId: input.actorId,
      createdAt: nowIso(),
    };

    this.store.saveVersion(version);

    template.currentVersionId = versionId;
    template.currentVersion = nextNumber;
    template.updatedAt = nowIso();
    this.store.saveTemplate(template);

    return { version, template };
  }

  getSystemDefault(): { template: CoachingTemplate; version: CoachingTemplateVersion } {
    const templates = this.store.listTemplates();
    const active = templates.find((t) => t.status === 'active' && !t.deletedAt);
    if (!active) {
      throw new DomainError('template_not_found', 'no active template found');
    }
    const version = this.store.getTemplateVersion(active.currentVersionId);
    if (!version) {
      throw new DomainError('template_not_found', 'system default template version not found');
    }
    return { template: active, version };
  }
}
