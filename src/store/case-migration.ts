import type { MediationCase, TemplateSelection, MainTopicConfig, CoachingTemplateVersion } from '../domain/types';

/**
 * Version resolver: maps a legacy versionId to a numeric versionNumber.
 * This is used during migration to deterministically pin the version.
 */
export type VersionResolver = (templateId: string, versionId: string) => number | undefined;

/**
 * Migrate a v1 case to v2 schema.
 * - Backfills templateSelection from system default template
 * - Backfills mainTopicConfig from existing topic/description
 * - Maps legacy versionId → versionNumber deterministically (c2_4 fix)
 * - Sets schemaVersion to 2
 */
export function migrateToV2(
  mediationCase: MediationCase,
  systemDefault: { templateId: string; versionId: string; templateVersion?: number },
  resolveVersion?: VersionResolver,
): boolean {
  if (mediationCase.schemaVersion && mediationCase.schemaVersion >= 2) {
    return false;
  }

  const now = new Date().toISOString();

  if (!mediationCase.templateSelection) {
    mediationCase.templateSelection = {
      templateId: systemDefault.templateId,
      templateVersion: systemDefault.templateVersion ?? 1,
      versionId: systemDefault.versionId,
      selectedAt: now,
      selectedBy: 'migration',
    };
  } else if (mediationCase.templateSelection.templateVersion === undefined) {
    // Deterministic backfill: resolve the legacy versionId to the real versionNumber
    const sel = mediationCase.templateSelection;
    let resolvedVersion: number | undefined;
    if (sel.versionId && resolveVersion) {
      resolvedVersion = resolveVersion(sel.templateId, sel.versionId);
    }
    // Use the resolved version, or the system default as last resort
    mediationCase.templateSelection.templateVersion = resolvedVersion ?? systemDefault.templateVersion ?? 1;
  }

  if (!mediationCase.mainTopicConfig && mediationCase.topic) {
    mediationCase.mainTopicConfig = {
      topic: mediationCase.topic,
      description: mediationCase.description || '',
      categoryId: '',
      confirmedAt: now,
    };
  }

  mediationCase.schemaVersion = 2;
  return true;
}

/**
 * Run migration on all cases in a store.
 * Returns the number of cases that were migrated.
 */
export function migrateCaseStore(
  cases: MediationCase[],
  systemDefault: { templateId: string; versionId: string; templateVersion?: number },
  resolveVersion?: VersionResolver,
): number {
  let migrated = 0;
  for (const mediationCase of cases) {
    if (migrateToV2(mediationCase, systemDefault, resolveVersion)) {
      migrated += 1;
    }
  }
  return migrated;
}
