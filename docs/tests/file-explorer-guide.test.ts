import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import ExplorerPage from '../pages/file-explorer/index.vue';
import { messages as english } from '../pages/file-explorer/messages/en';
import { messages as japanese } from '../pages/file-explorer/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('File Explorer guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('renders the complete browse-to-download workflow in $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(ExplorerPage, { locale, s, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-file-explorer"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect(article?.querySelector('a[data-docs-app-entry-path]')?.getAttribute('data-docs-app-entry-path')).toBe('/#/');
    expect([...article?.querySelectorAll('section.explorer-step h2') ?? []].map(node => node.textContent)).toEqual([
      s.open_location_title, s.browse_files_title, s.upload_files_title, s.download_files_title, s.organize_files_title,
    ]);
    expect([...article?.querySelectorAll('[data-docs-animation]') ?? []].map(node => node.getAttribute('data-docs-animation'))).toEqual([
      'explorer-open', 'explorer-browse', 'explorer-upload', 'explorer-download', 'explorer-organize',
    ]);
    expect(article?.querySelector('[data-testid="explorer-step-upload"]')?.textContent).toContain(s.placement_preview);
    expect(article?.querySelector('[data-testid="explorer-step-upload"]')?.textContent).toContain(s.planned_overwrite);
    expect(article?.querySelector('[data-testid="explorer-step-download"]')?.textContent).toContain(s.exclude_items);
    for (const stage of ['browse', 'download']) {
      expect(article?.querySelector(`[data-testid="explorer-step-${stage}"] [data-testid="explorer-lock-closed"]`)).not.toBeNull();
      expect(article?.querySelector(`[data-testid="explorer-step-${stage}"] [data-testid="explorer-lock-open"]`)).toBeNull();
    }
    expect(article?.querySelector('[data-testid="explorer-step-upload"] [data-testid="explorer-lock-open"]')).not.toBeNull();
    expect(article?.querySelector('[data-testid="explorer-step-organize"] [data-testid="explorer-lock-closed"]')).not.toBeNull();
    expect(article?.querySelector('[data-testid="explorer-step-organize"] [data-testid="explorer-lock-open"]')).not.toBeNull();
    expect(article?.textContent).toContain(locale === 'en' ? 'Unlock the window' : '画面のロックを解除');
    expect(article?.querySelectorAll('figure button, figure input, figure a')).toHaveLength(0);
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/file-access/`, `/docs/${locale}/tool-browser-shell/`,
    ]);
  });
});
