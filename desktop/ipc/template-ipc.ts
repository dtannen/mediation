import { CH } from './channel-manifest';
import { DomainError } from '../../src/domain/errors';
import { ipcSuccess, ipcError } from '../../src/contracts/common';
import type { IpcErrorResponse } from '../../src/contracts/common';
import { appendAuditEvent, createAuditEvent } from '../../src/audit/audit-service';

interface IpcRegistry {
  handle: (ipcMain: unknown, channel: string, handler: (event: unknown, payload: any) => Promise<unknown> | unknown) => void;
}

interface TemplateService {
  listCategories: () => Record<string, unknown>[];
  createCategory: (input: { name: string; description?: string }) => Record<string, unknown>;
  updateCategory: (categoryId: string, input: { name?: string; description?: string }) => Record<string, unknown>;
  deleteCategory: (categoryId: string) => { categoryId: string; deletedAt: string };
  listTemplates: (categoryId?: string, opts?: { includeArchived?: boolean }) => Record<string, unknown>[];
  getTemplate: (templateId: string) => Record<string, unknown>;
  getTemplateWithVersion: (templateId: string, version?: number) => { template: Record<string, unknown>; version: Record<string, unknown> };
  getTemplateVersion?: (templateId: string, versionNumber: number) => Record<string, unknown> | undefined;
  listVersions?: (templateId: string) => Record<string, unknown>[];
  createTemplate: (input: Record<string, unknown>) => { template: Record<string, unknown>; version: Record<string, unknown> };
  updateTemplateMeta: (templateId: string, input: Record<string, unknown>) => Record<string, unknown>;
  createVersion: (templateId: string, input: Record<string, unknown>) => { version: Record<string, unknown>; template: Record<string, unknown> };
  setTemplateStatus: (templateId: string, status: 'active' | 'archived') => Record<string, unknown>;
  deleteTemplate: (templateId: string, caseStore?: unknown) => { templateId: string; deletedAt: string };
}

interface UserProfileStore {
  getProfile: (actorId: string) => { isAdmin?: boolean } | undefined;
}

export function register(
  ipcMain: unknown,
  deps: {
    registry: IpcRegistry;
    templateService: TemplateService;
    userProfileStore?: UserProfileStore;
    caseStore?: unknown;
    auditLogPath?: string;
  },
): void {
  const r = deps.registry;
  const svc = deps.templateService;
  const auditPath = deps.auditLogPath || '';

  function resolveIsAdmin(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const p = payload as Record<string, unknown>;
    const actorId = typeof p.actorId === 'string' ? p.actorId.trim() : '';
    if (!actorId) return false;

    // Check user profile store for isAdmin flag
    if (deps.userProfileStore) {
      const profile = deps.userProfileStore.getProfile(actorId);
      return profile?.isAdmin === true;
    }

    // Fallback: no profile store means we cannot verify — deny by default
    return false;
  }

  function assertAdmin(payload: unknown): void {
    if (!resolveIsAdmin(payload)) {
      throw new DomainError('unauthorized_admin_action', 'admin access required');
    }
  }

  async function logAudit(
    actorId: string,
    action: string,
    targetId: string,
    outcome: 'success' | 'denied',
    errorMsg?: string,
  ): Promise<void> {
    if (!auditPath) return;
    try {
      const event = createAuditEvent({
        case_id: '',
        phase: 'closed' as any, // not case-related
        actor_type: 'admin',
        actor_id: actorId,
        event_type: `template.${action}`,
        target_id: targetId, // Section 1.3: explicit targetId for template/case
        policy_decision: outcome,
        error: errorMsg,
      });
      await appendAuditEvent(auditPath, event);
    } catch {
      // best-effort audit
    }
  }

  function getActorId(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return '';
    return typeof (payload as Record<string, unknown>).actorId === 'string'
      ? ((payload as Record<string, unknown>).actorId as string).trim()
      : '';
  }

  r.handle(ipcMain, CH.TPL_LIST_CATEGORIES, async () => {
    try {
      return ipcSuccess(svc.listCategories());
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_CREATE_CATEGORY, async (_event, payload) => {
    const actorId = getActorId(payload);
    try {
      assertAdmin(payload);
      const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
      if (!name) {
        throw new DomainError('invalid_payload', 'Category name is required');
      }
      const category = svc.createCategory({
        name,
        description: typeof payload?.description === 'string' ? payload.description : '',
      });
      await logAudit(actorId, 'create_category', (category as any).id || '', 'success');
      return ipcSuccess({ category });
    } catch (err) {
      const isDenied = err instanceof DomainError && err.code === 'unauthorized_admin_action';
      await logAudit(actorId, 'create_category', '', 'denied',
        isDenied ? 'unauthorized' : (err instanceof Error ? err.message : String(err)));
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_UPDATE_CATEGORY, async (_event, payload) => {
    const actorId = getActorId(payload);
    const categoryId = String(payload?.categoryId || '');
    try {
      assertAdmin(payload);
      if (!categoryId) {
        throw new DomainError('invalid_payload', 'categoryId is required');
      }
      const category = svc.updateCategory(categoryId, {
        name: typeof payload?.name === 'string' ? payload.name : undefined,
        description: typeof payload?.description === 'string' ? payload.description : undefined,
      });
      await logAudit(actorId, 'update_category', categoryId, 'success');
      return ipcSuccess({ category });
    } catch (err) {
      const isDenied = err instanceof DomainError && err.code === 'unauthorized_admin_action';
      await logAudit(actorId, 'update_category', categoryId, 'denied',
        isDenied ? 'unauthorized' : (err instanceof Error ? err.message : String(err)));
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_DELETE_CATEGORY, async (_event, payload) => {
    const actorId = getActorId(payload);
    const categoryId = String(payload?.categoryId || '');
    try {
      assertAdmin(payload);
      if (!categoryId) {
        throw new DomainError('invalid_payload', 'categoryId is required');
      }
      const result = svc.deleteCategory(categoryId);
      await logAudit(actorId, 'delete_category', categoryId, 'success');
      return ipcSuccess(result);
    } catch (err) {
      const isDenied = err instanceof DomainError && err.code === 'unauthorized_admin_action';
      await logAudit(actorId, 'delete_category', categoryId, 'denied',
        isDenied ? 'unauthorized' : (err instanceof Error ? err.message : String(err)));
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_LIST, async (_event, payload) => {
    try {
      const categoryId = typeof payload?.categoryId === 'string' ? payload.categoryId : undefined;
      const includeArchived = payload?.includeArchived === true;
      return ipcSuccess(svc.listTemplates(categoryId, { includeArchived }));
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_GET, async (_event, payload) => {
    try {
      const templateId = String(payload?.templateId || '');
      const version = typeof payload?.version === 'number' ? payload.version : undefined;
      const result = svc.getTemplateWithVersion(templateId, version);
      // Include all versions for admin UI (c1_8 fix)
      let versions: Record<string, unknown>[] = [];
      try {
        if (typeof svc.listVersions === 'function') {
          versions = svc.listVersions(templateId);
        }
      } catch {
        // best-effort
      }
      return ipcSuccess({ template: result.template, version: result.version, versions });
    } catch (err) {
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_CREATE, async (_event, payload) => {
    const actorId = getActorId(payload);
    const targetId = String(payload?.templateId || '');
    try {
      assertAdmin(payload);
      // V2 spec validation: enforce ALL required fields per Section 7 CreateTemplateRequest.
      // globalGuidance, changeNote, actorId, name are all required (non-optional) in the v2 contract.
      // Legacy preambles-only payloads are rejected on v2 channels.
      if (!actorId) {
        throw new DomainError('invalid_payload', 'actorId is required for template creation');
      }
      const createName = typeof payload?.name === 'string' ? payload.name.trim() : '';
      if (!createName) {
        throw new DomainError('invalid_payload', 'name is required for template creation (Section 7)');
      }
      const createGuidance = typeof payload?.globalGuidance === 'string' ? payload.globalGuidance.trim() : '';
      if (!createGuidance) {
        throw new DomainError('invalid_payload', 'globalGuidance is required for template creation (Section 7)');
      }
      const createChangeNote = typeof payload?.changeNote === 'string' ? payload.changeNote.trim() : '';
      if (!createChangeNote) {
        throw new DomainError('invalid_payload', 'changeNote is required for template creation (Section 7)');
      }
      const result = svc.createTemplate(payload || {});
      const newTemplateId = (result.template as any)?.id || '';
      await logAudit(actorId, 'create', newTemplateId, 'success');
      return ipcSuccess({ template: result.template, version: result.version });
    } catch (err) {
      const isDenied = err instanceof DomainError && err.code === 'unauthorized_admin_action';
      await logAudit(actorId, 'create', targetId, 'denied',
        isDenied ? 'unauthorized' : (err instanceof Error ? err.message : String(err)));
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_UPDATE_META, async (_event, payload) => {
    const actorId = getActorId(payload);
    const templateId = String(payload?.templateId || '');
    try {
      assertAdmin(payload);
      const template = svc.updateTemplateMeta(templateId, payload || {});
      await logAudit(actorId, 'update_meta', templateId, 'success');
      return ipcSuccess({ template });
    } catch (err) {
      const isDenied = err instanceof DomainError && err.code === 'unauthorized_admin_action';
      await logAudit(actorId, 'update_meta', templateId, 'denied',
        isDenied ? 'unauthorized' : (err instanceof Error ? err.message : String(err)));
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_CREATE_VERSION, async (_event, payload) => {
    const actorId = getActorId(payload);
    const templateId = String(payload?.templateId || '');
    try {
      assertAdmin(payload);
      // V2 spec enforcement: globalGuidance, changeNote, and actorId are ALL required
      // for new versions per Section 7 CreateVersionRequest. Legacy changeNotes rejected.
      if (!actorId) {
        throw new DomainError('invalid_payload', 'actorId is required when publishing a new version');
      }
      const versionGuidance = typeof payload?.globalGuidance === 'string' ? payload.globalGuidance.trim() : '';
      if (!versionGuidance) {
        throw new DomainError('invalid_payload', 'globalGuidance is required when publishing a new version (Section 7)');
      }
      const changeNote = typeof payload?.changeNote === 'string' ? payload.changeNote.trim() : '';
      if (!changeNote) {
        throw new DomainError('invalid_payload', 'changeNote is required when publishing a new version (Section 7)');
      }
      const result = svc.createVersion(templateId, payload || {});
      await logAudit(actorId, 'create_version', templateId, 'success');
      return ipcSuccess({ version: result.version, template: result.template });
    } catch (err) {
      const isDenied = err instanceof DomainError && err.code === 'unauthorized_admin_action';
      await logAudit(actorId, 'create_version', templateId, 'denied',
        isDenied ? 'unauthorized' : (err instanceof Error ? err.message : String(err)));
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_SET_STATUS, async (_event, payload) => {
    const actorId = getActorId(payload);
    const templateId = String(payload?.templateId || '');
    try {
      assertAdmin(payload);
      const status = payload?.status === 'archived' ? 'archived' as const : 'active' as const;
      const template = svc.setTemplateStatus(templateId, status);
      await logAudit(actorId, 'set_status', templateId, 'success');
      return ipcSuccess({ template });
    } catch (err) {
      const isDenied = err instanceof DomainError && err.code === 'unauthorized_admin_action';
      await logAudit(actorId, 'set_status', templateId, 'denied',
        isDenied ? 'unauthorized' : (err instanceof Error ? err.message : String(err)));
      return ipcError(err);
    }
  });

  r.handle(ipcMain, CH.TPL_DELETE, async (_event, payload) => {
    const actorId = getActorId(payload);
    const templateId = String(payload?.templateId || '');
    try {
      assertAdmin(payload);
      const result = svc.deleteTemplate(templateId, deps.caseStore);
      await logAudit(actorId, 'delete', templateId, 'success');
      return ipcSuccess({ templateId: result.templateId, deletedAt: result.deletedAt });
    } catch (err) {
      const isDenied = err instanceof DomainError && err.code === 'unauthorized_admin_action';
      await logAudit(actorId, 'delete', templateId, 'denied',
        isDenied ? 'unauthorized' : (err instanceof Error ? err.message : String(err)));
      return ipcError(err);
    }
  });
}
