import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { FileBackedTemplateStore } from '../store/template-store';
import { TemplateService } from '../app/template-service';
import { runCases, assertDomainErrorCode } from './test-utils';

function tmpStorePath(): string {
  const dir = path.join(process.cwd(), 'dist', '.test-tmp');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `templates-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return p;
}

function cleanup(p: string): void {
  try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
}

export async function runTemplateTests(): Promise<{ passed: number; failed: number }> {
  return runCases('template', [
    {
      name: 'seeds default category and template on first load',
      run: () => {
        const p = tmpStorePath();
        try {
          const store = new FileBackedTemplateStore(p);
          const svc = new TemplateService(store);

          const cats = svc.listCategories();
          assert.equal(cats.length, 1);
          assert.equal(cats[0].name, 'General');

          const templates = svc.listTemplates();
          assert.equal(templates.length, 1);
          assert.equal(templates[0].name, 'General Mediation');
          assert.equal(templates[0].status, 'active');

          const { version } = svc.getTemplateWithVersion(templates[0].id);
          assert.equal(version.versionNumber, 1);
          assert.ok(version.preambles?.intake);
          assert.ok(version.preambles?.draft_coach);
          assert.ok(version.preambles?.mediator);
        } finally {
          cleanup(p);
        }
      },
    },
    {
      name: 'create template with version',
      run: () => {
        const p = tmpStorePath();
        try {
          const store = new FileBackedTemplateStore(p);
          const svc = new TemplateService(store);

          const cats = svc.listCategories();
          const { template, version } = svc.createTemplate({
            categoryId: cats[0].id,
            name: 'Custom Template',
            description: 'A custom template',
            preambles: { intake: 'custom intake', draft_coach: 'custom draft', mediator: 'custom mediator' },
            instructions: { intake: 'inst intake', draft_coach: 'inst draft', mediator: 'inst mediator' },
            actorId: 'admin_1',
          });

          assert.equal(template.name, 'Custom Template');
          assert.equal(template.categoryId, cats[0].id);
          assert.equal(version.versionNumber, 1);
          assert.equal(version.preambles?.intake, 'custom intake');

          const templates = svc.listTemplates();
          assert.equal(templates.length, 2);
        } finally {
          cleanup(p);
        }
      },
    },
    {
      name: 'create version increments version number',
      run: () => {
        const p = tmpStorePath();
        try {
          const store = new FileBackedTemplateStore(p);
          const svc = new TemplateService(store);

          const templates = svc.listTemplates();
          const templateId = templates[0].id;

          const v2 = svc.createVersion(templateId, {
            preambles: { intake: 'v2 intake', draft_coach: 'v2 draft', mediator: 'v2 mediator' },
            instructions: { intake: 'v2 inst', draft_coach: 'v2 inst', mediator: 'v2 inst' },
            changeNotes: 'Updated preambles',
            actorId: 'admin_1',
          });

          assert.equal(v2.version.versionNumber, 2);
          assert.equal(v2.version.preambles?.intake, 'v2 intake');

          const { version: current } = svc.getTemplateWithVersion(templateId);
          assert.equal(current.id, v2.version.id);
        } finally {
          cleanup(p);
        }
      },
    },
    {
      name: 'set template status to archived',
      run: () => {
        const p = tmpStorePath();
        try {
          const store = new FileBackedTemplateStore(p);
          const svc = new TemplateService(store);

          const templates = svc.listTemplates();
          const updated = svc.setTemplateStatus(templates[0].id, 'archived');
          assert.equal(updated.status, 'archived');
        } finally {
          cleanup(p);
        }
      },
    },
    {
      name: 'delete template removes it',
      run: () => {
        const p = tmpStorePath();
        try {
          const store = new FileBackedTemplateStore(p);
          const svc = new TemplateService(store);

          const cats = svc.listCategories();
          const { template } = svc.createTemplate({
            categoryId: cats[0].id,
            name: 'To Delete',
            preambles: { intake: 'x', draft_coach: 'x', mediator: 'x' },
            instructions: { intake: 'x', draft_coach: 'x', mediator: 'x' },
            actorId: 'admin',
          });

          assert.equal(svc.listTemplates().length, 2);
          svc.deleteTemplate(template.id);
          assert.equal(svc.listTemplates().length, 1);
        } finally {
          cleanup(p);
        }
      },
    },
    {
      name: 'delete blocked when template in use',
      run: () => {
        const p = tmpStorePath();
        try {
          const store = new FileBackedTemplateStore(p);
          const svc = new TemplateService(store);

          const templates = svc.listTemplates();
          const templateId = templates[0].id;

          const mockCaseStore = {
            list: () => [{ templateSelection: { templateId } }],
          };

          assert.throws(
            () => svc.deleteTemplate(templateId, mockCaseStore),
            (err: unknown) => {
              assertDomainErrorCode(err, 'template_in_use');
              return true;
            },
          );
        } finally {
          cleanup(p);
        }
      },
    },
    {
      name: 'getSystemDefault returns first active template',
      run: () => {
        const p = tmpStorePath();
        try {
          const store = new FileBackedTemplateStore(p);
          const svc = new TemplateService(store);

          const result = svc.getSystemDefault();
          assert.ok(result.template);
          assert.ok(result.version);
          assert.equal(result.template.status, 'active');
        } finally {
          cleanup(p);
        }
      },
    },
    {
      name: 'persists and reloads from disk',
      run: () => {
        const p = tmpStorePath();
        try {
          const store1 = new FileBackedTemplateStore(p);
          const svc1 = new TemplateService(store1);
          const cats = svc1.listCategories();

          svc1.createTemplate({
            categoryId: cats[0].id,
            name: 'Persisted Template',
            preambles: { intake: 'p', draft_coach: 'p', mediator: 'p' },
            instructions: { intake: 'p', draft_coach: 'p', mediator: 'p' },
            actorId: 'admin',
          });

          // Reload from disk
          const store2 = new FileBackedTemplateStore(p);
          const svc2 = new TemplateService(store2);

          assert.equal(svc2.listTemplates().length, 2);
          const found = svc2.listTemplates().find((t) => t.name === 'Persisted Template');
          assert.ok(found);
        } finally {
          cleanup(p);
        }
      },
    },
  ]);
}
