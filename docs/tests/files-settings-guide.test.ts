import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import SettingsPage from '../pages/files-and-folders-settings/index.vue';
import { strings as english } from '../pages/files-and-folders-settings/strings/en';
import { strings as japanese } from '../pages/files-and-folders-settings/strings/ja';
import { strings as commonEnglish } from '../strings/common/en';
import { strings as commonJapanese } from '../strings/common/ja';
import { parsePage } from './site.test-support';
import { visibleGuideText } from './ui-label.test-support';

describe('Files and folders Settings guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('renders the Settings workflow and localized result in $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(SettingsPage, { locale, s, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-files-settings"]');
    expect(article?.querySelector('h1')?.textContent).toBe(s.title);
    expect([...article?.querySelectorAll('a[data-docs-app-entry-path]') ?? []].map(link => link.getAttribute('data-docs-app-entry-path'))).toEqual([
      '/#/settings/binary-objects', '/#/settings/volumes',
    ]);
    expect([...article?.querySelectorAll('section.walkthrough-step h2') ?? []].map(node => node.textContent)).toEqual([
      s.steps.open.title, s.steps.files.title, s.steps.choose.title, s.steps.copy.title, s.steps.manage.title,
    ]);
    expect([...article?.querySelectorAll('[data-docs-animation]') ?? []].map(node => node.getAttribute('data-docs-animation'))).toEqual([
      'files-settings-open', 'files-settings-files', 'files-settings-choose', 'files-settings-copy', 'files-settings-manage',
    ]);
    expect(article?.querySelector('[data-testid="files-settings-step-files"]')?.textContent).toContain(s.demo.filesHeading);
    expect(article?.querySelector('[data-testid="files-settings-step-files"] .files-focus')?.textContent).toContain(s.demo.fileName);
    expect(article?.querySelector('[data-testid="files-settings-step-files"] .files-focus')?.textContent).toContain(s.demo.download);
    expect(article?.querySelector('#files-settings-files')?.parentElement?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/wesh-sysfs/`);
    expect(article?.querySelector('[data-testid="files-settings-step-manage"]')?.textContent).toContain(s.demo.inUse);
    expect(article?.querySelector('[data-testid="files-settings-step-copy"]')?.textContent).toContain(s.demo.copied);
    expect(article?.querySelector('[data-testid="files-settings-step-manage"]')?.textContent).toContain(s.demo.copied);
    expect(article?.textContent).toContain(visibleGuideText({ text: s.after }));
    expect(article?.querySelectorAll('figure button, figure input, figure a')).toHaveLength(0);
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/file-access/`, `/docs/${locale}/tool-browser-shell/`,
    ]);
  });
});
