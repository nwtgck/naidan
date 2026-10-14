import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import ExplorerPage from '../pages/file-explorer/index.vue';
import { strings as english } from '../pages/file-explorer/strings/en';
import { strings as japanese } from '../pages/file-explorer/strings/ja';
import { strings as commonEnglish } from '../strings/common/en';
import { strings as commonJapanese } from '../strings/common/ja';
import { parsePage } from './site.test-support';
import { visibleGuideText } from './ui-label.test-support';

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
      s.steps.open.title, s.steps.browse.title, s.steps.upload.title, s.steps.download.title, s.steps.organize.title,
    ]);
    expect([...article?.querySelectorAll('[data-docs-animation]') ?? []].map(node => node.getAttribute('data-docs-animation'))).toEqual([
      'explorer-open', 'explorer-browse', 'explorer-upload', 'explorer-download', 'explorer-organize',
    ]);
    expect(article?.querySelector('[data-testid="explorer-step-upload"]')?.textContent).toContain(s.demo.placementPreview);
    expect(article?.querySelector('[data-testid="explorer-step-upload"]')?.textContent).toContain(s.demo.plannedOverwrite);
    expect(article?.querySelector('[data-testid="explorer-step-download"]')?.textContent).toContain(s.demo.excludeItems);
    for (const stage of ['browse', 'download']) {
      expect(article?.querySelector(`[data-testid="explorer-step-${stage}"] [data-testid="explorer-lock-closed"]`)).not.toBeNull();
      expect(article?.querySelector(`[data-testid="explorer-step-${stage}"] [data-testid="explorer-lock-open"]`)).toBeNull();
    }
    expect(article?.querySelector('[data-testid="explorer-step-upload"] [data-testid="explorer-lock-open"]')).not.toBeNull();
    expect(article?.querySelector('[data-testid="explorer-step-organize"] [data-testid="explorer-lock-closed"]')).not.toBeNull();
    expect(article?.querySelector('[data-testid="explorer-step-organize"] [data-testid="explorer-lock-open"]')).not.toBeNull();
    expect(article?.textContent).toContain(visibleGuideText({ text: s.steps.organize.body }));
    expect(article?.querySelectorAll('figure button, figure input, figure a')).toHaveLength(0);
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/file-access/`, `/docs/${locale}/tool-browser-shell/`,
    ]);
  });
});
