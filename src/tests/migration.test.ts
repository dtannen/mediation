import assert from 'node:assert/strict';
import { migrateToV2, migrateCaseStore } from '../store/case-migration';
import type { MediationCase, TemplateSelection, MainTopicConfig } from '../domain/types';
import { runCases } from './test-utils';

function makeMinimalCase(overrides: Partial<MediationCase> = {}): MediationCase {
  return {
    id: 'case_test',
    topic: 'Test Topic',
    description: 'Test description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phase: 'group_chat',
    parties: [],
    inviteLink: { token: 'tok', url: 'http://test', createdAt: new Date().toISOString() },
    partyParticipationById: {},
    consent: { byPartyId: {} },
    privateIntakeByPartyId: {},
    groupChat: { opened: true, introductionsSent: false, mediatorSummary: '', messages: [], draftsById: {} },
    ...overrides,
  };
}

const SYSTEM_DEFAULT = { templateId: 'tpl_default', versionId: 'tplv_default' };

export async function runMigrationTests(): Promise<{ passed: number; failed: number }> {
  return runCases('migration', [
    {
      name: 'migrates v1 case to v2 with backfilled fields',
      run: () => {
        const c = makeMinimalCase();
        assert.equal(c.schemaVersion, undefined);
        assert.equal(c.templateSelection, undefined);
        assert.equal(c.mainTopicConfig, undefined);

        const changed = migrateToV2(c, SYSTEM_DEFAULT);
        assert.equal(changed, true);
        assert.equal(c.schemaVersion, 2);
        assert.ok(c.templateSelection);
        assert.equal((c.templateSelection as TemplateSelection).templateId, 'tpl_default');
        assert.equal((c.templateSelection as TemplateSelection).selectedBy, 'migration');
        assert.ok(c.mainTopicConfig);
        assert.equal((c.mainTopicConfig as MainTopicConfig).topic, 'Test Topic');
        assert.equal((c.mainTopicConfig as MainTopicConfig).description, 'Test description');
      },
    },
    {
      name: 'does not migrate case already at v2',
      run: () => {
        const c = makeMinimalCase({ schemaVersion: 2 });
        const changed = migrateToV2(c, SYSTEM_DEFAULT);
        assert.equal(changed, false);
        assert.equal(c.templateSelection, undefined);
      },
    },
    {
      name: 'preserves existing templateSelection during migration',
      run: () => {
        const c = makeMinimalCase({
          templateSelection: {
            templateId: 'tpl_custom',
            templateVersion: 1,
            versionId: 'tplv_custom',
            selectedAt: new Date().toISOString(),
            selectedBy: 'user',
          },
        });

        const changed = migrateToV2(c, SYSTEM_DEFAULT);
        assert.equal(changed, true);
        assert.equal(c.templateSelection!.templateId, 'tpl_custom');
      },
    },
    {
      name: 'skips mainTopicConfig backfill if topic is empty',
      run: () => {
        const c = makeMinimalCase({ topic: '' });
        migrateToV2(c, SYSTEM_DEFAULT);
        assert.equal(c.mainTopicConfig, undefined);
      },
    },
    {
      name: 'migrateCaseStore migrates multiple cases and returns count',
      run: () => {
        const cases = [
          makeMinimalCase({ id: 'case_1' }),
          makeMinimalCase({ id: 'case_2', schemaVersion: 2 }),
          makeMinimalCase({ id: 'case_3' }),
        ];

        const count = migrateCaseStore(cases, SYSTEM_DEFAULT);
        assert.equal(count, 2);
        assert.equal(cases[0].schemaVersion, 2);
        assert.equal(cases[1].schemaVersion, 2);
        assert.equal(cases[2].schemaVersion, 2);
      },
    },
  ]);
}
