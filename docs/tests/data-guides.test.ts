import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import StoragePage from '../pages/data/storage.vue';
import BackupPage from '../pages/data/backup.vue';
import { strings as storageEn } from '../strings/data/storage/en';
import { strings as storageJa } from '../strings/data/storage/ja';
import { strings as backupEn } from '../strings/data/backup/en';
import { strings as backupJa } from '../strings/data/backup/ja';
import { strings as commonEn } from '../strings/common/en';
import { strings as commonJa } from '../strings/common/ja';
import { parsePage } from './site.test-support';
import { visibleGuideText } from './ui-label.test-support';

describe('data guides', () => {
  it.each([
    { locale: 'en', s: storageEn, common: commonEn },
    { locale: 'ja', s: storageJa, common: commonJa },
  ] as const)('renders the complete $locale storage sequence in static HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(StoragePage, { locale, s, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-data-storage"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelectorAll('.walkthrough-step')).toHaveLength(3);

    for (const stage of ['open', 'choose', 'persist'] as const) {
      const step = article?.querySelector(`#storage-${stage}`)?.closest('section');
      expect(step?.textContent).toContain(visibleGuideText({ text: s.steps[stage].body }));
      expect(step?.querySelector(`[data-docs-animation="storage-${stage}"]`)).not.toBeNull();
    }

    const choice = article?.querySelector('[data-testid="storage-step-choose"]');
    expect(choice?.querySelector('.app-canvas .settings-window .storage-section')).not.toBeNull();
    expect(choice?.querySelector('.confirm-dialog')?.textContent).toContain(s.demo.switchAndMigrate);
    expect(choice?.textContent).toContain(s.demo.opfs);
    expect(choice?.textContent).toContain(s.demo.local);
    expect(choice?.textContent).toContain(s.demo.memory);
    expect(choice?.textContent).toContain(s.demo.switchAndMigrate);
    expect(article?.querySelector('[data-testid="storage-step-persist"]')?.textContent).toContain(s.demo.protected);
    expect(article?.textContent).toContain(s.limits[0]);
    expect(article?.querySelector('.next-link')?.getAttribute('href')).toBe(`/docs/${locale}/data/backup/`);
  });

  it.each([
    { locale: 'en', s: backupEn, common: commonEn },
    { locale: 'ja', s: backupJa, common: commonJa },
  ] as const)('renders the complete $locale backup and import choices in static HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(BackupPage, { locale, s, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-data-backup"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelectorAll('.walkthrough-step')).toHaveLength(3);

    for (const stage of ['export', 'preview', 'mode'] as const) {
      const step = article?.querySelector(`#backup-${stage}`)?.closest('section');
      expect(step?.textContent).toContain(visibleGuideText({ text: s.steps[stage].body }));
      expect(step?.querySelector(`[data-docs-animation="backup-${stage}"]`)).not.toBeNull();
    }

    expect(article?.querySelector('[data-testid="backup-step-export"]')?.textContent).toContain(s.demo.excludeHistory);
    expect(article?.querySelector('[data-testid="backup-step-preview"]')?.textContent).toContain(s.demo.contentPreview);
    const mode = article?.querySelector('[data-testid="backup-step-mode"]');
    expect(mode?.querySelector('.app-canvas .settings-window .backup-card')).not.toBeNull();
    expect(mode?.querySelector('.import-window .archive-summary')?.textContent).toContain(s.demo.chosenZip);
    expect(mode?.textContent).toContain(s.demo.append);
    expect(mode?.textContent).toContain(s.demo.replace);
    expect(article?.textContent).toContain(visibleGuideText({ text: s.scopeBody }));
    expect(article?.textContent).toContain(s.careBody);
    expect(article?.querySelector('.next-link')?.getAttribute('href')).toBe(`/docs/${locale}/data/storage/`);
  });
});
