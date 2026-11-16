import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import type { VNode } from 'vue';
import { renderToString } from '@vue/server-renderer';
import StoragePage from '../pages/data-storage/index.vue';
import BackupPage from '../pages/data-backup/index.vue';
import { messages as storageEn } from '../pages/data-storage/messages/en';
import { messages as storageJa } from '../pages/data-storage/messages/ja';
import { messages as backupEn } from '../pages/data-backup/messages/en';
import { messages as backupJa } from '../pages/data-backup/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

async function renderedText({ node }: { node: VNode }) {
  const html = await renderToString(createSSRApp({ render: () => node }));
  using page = parsePage({ html });
  return page.document.body.textContent;
}

describe('data guides', () => {
  it.each([
    { locale: 'en', s: storageEn, common: commonEn },
    { locale: 'ja', s: storageJa, common: commonJa },
  ] as const)('renders the complete $locale storage sequence in static HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(StoragePage, { locale, s, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-data-storage"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('.app-entry-intro a[data-docs-app-entry-path="/#/"]')?.textContent).toBe('Naidan');
    expect(article?.querySelectorAll('.walkthrough-step')).toHaveLength(3);

    const body = { open: s.open_storage_settings_instructions, choose: s.choose_storage_provider_instructions, persist: s.request_persistent_storage_instructions };
    for (const stage of ['open', 'choose', 'persist'] as const) {
      const step = article?.querySelector(`#storage-${stage}`)?.closest('section');
      expect(step?.textContent).toContain(await renderedText({ node: body[stage]() }));
      expect(step?.querySelector(`[data-docs-animation="storage-${stage}"]`)).not.toBeNull();
    }

    const choice = article?.querySelector('[data-testid="storage-step-choose"]');
    expect(choice?.querySelector('.app-canvas .settings-window .storage-section')).not.toBeNull();
    expect(choice?.querySelector('.confirm-dialog')?.textContent).toContain(s.switch_migrate);
    expect(choice?.textContent).toContain(s.origin_private_file_system_opfs);
    expect(choice?.textContent).toContain(s.local_storage);
    expect(choice?.textContent).toContain(s.ephemeral);
    expect(choice?.textContent).toContain(s.switch_migrate);
    expect(article?.querySelector('[data-testid="storage-step-persist"]')?.textContent).toContain(s.protected);
    expect(article?.textContent).toContain(s.browser_data_loss_risks);
    const related = article?.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.related_guides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/data-backup/`);
    expect(related?.textContent).toContain(s.export_and_restore_a_zip);
  });

  it.each([
    { locale: 'en', s: backupEn, common: commonEn },
    { locale: 'ja', s: backupJa, common: commonJa },
  ] as const)('renders the complete $locale backup and import choices in static HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(BackupPage, { locale, s, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-data-backup"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('.app-entry-intro a[data-docs-app-entry-path="/#/"]')?.textContent).toBe('Naidan');
    expect(article?.querySelectorAll('.walkthrough-step')).toHaveLength(4);

    const body = { export: s.download_backup_zip_instructions, base64: s.base64_instructions, preview: s.inspect_archive_instructions };
    for (const stage of ['export', 'base64', 'preview'] as const) {
      const step = article?.querySelector(`#backup-${stage}`)?.closest('section');
      expect(step?.textContent).toContain(await renderedText({ node: body[stage]() }));
      expect(step?.querySelector(`[data-docs-animation="backup-${stage}"]`)).not.toBeNull();
    }
    const modeSection = article?.querySelector('#backup-mode')?.closest('section');
    const modeParagraphs = [...(modeSection?.querySelectorAll(':scope > p') ?? [])];
    const instructions = s.choose_import_mode_instructions();
    expect(modeParagraphs).toHaveLength(4);
    for (const [index, instruction] of instructions.entries()) {
      expect(modeParagraphs[index]?.textContent).toBe(await renderedText({ node: instruction }));
    }
    expect(modeSection?.querySelector('[data-docs-animation="backup-mode"]')).not.toBeNull();

    expect(article?.querySelector('[data-testid="backup-step-export"]')?.textContent).toContain(s.exclude_chat_history);
    expect(article?.querySelector('[data-testid="backup-step-export"] .export-split')?.textContent).toContain(s.download_zip);
    const generated = article?.querySelector('[data-testid="backup-generated-archive"]');
    expect(generated?.querySelector('.generated-read-only')?.textContent).toContain(s.read_only);
    expect(generated?.querySelector('.generated-breadcrumb')?.textContent).toContain(s.example_backup_zip_filename);
    expect(generated?.querySelector('.generated-breadcrumb')?.textContent).not.toContain('OPFS');
    expect(generated?.textContent).not.toContain(locale === 'en' ? 'Paste' : '貼り付け');
    const base64 = article?.querySelector('[data-testid="backup-step-base64"]');
    expect(base64?.querySelector('[data-testid="backup-base64-export"]')?.textContent).toContain(s.prepare_base64);
    expect(base64?.querySelector('[data-testid="backup-base64-copy"]')?.textContent).toContain(s.copy_base64);
    expect(base64?.querySelector('[data-testid="backup-base64-import"]')?.textContent).toContain(s.read_base64);
    expect(article?.textContent).toContain(s.base64_explanation);
    expect(article?.querySelectorAll('figure button, figure input, figure textarea, figure a')).toHaveLength(0);
    expect(article?.querySelector('[data-testid="backup-step-preview"]')?.textContent).toContain(s.content_preview);
    const mode = article?.querySelector('[data-testid="backup-step-mode"]');
    expect(mode?.querySelector('.app-canvas .settings-window .backup-card')).not.toBeNull();
    expect(mode?.querySelector('.import-window .archive-summary')?.textContent).toContain(s.chosen_backup_zip_filename);
    expect(mode?.textContent).toContain(s.append_merge);
    expect(mode?.textContent).toContain(s.replace_restore);
    expect(article?.textContent).toContain(await renderedText({ node: s.zip_contents_and_exclusions() }));
    expect(article?.textContent).toContain(s.keep_backup_useful_instructions);
    const related = article?.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.related_guides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/data-storage/`);
    expect(related?.textContent).toContain(s.compare_storage_provider_options);
  });
});
