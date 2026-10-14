import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import SettingsPage from '../pages/files-and-folders-settings/index.vue';
import { messages as english } from '../pages/files-and-folders-settings/messages/en';
import { messages as japanese } from '../pages/files-and-folders-settings/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';

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
      s.open_settings_title, s.inspect_saved_files_title, s.link_working_folder_title, s.copy_working_folder_title, s.manage_working_folder_title,
    ]);
    expect([...article?.querySelectorAll('[data-docs-animation]') ?? []].map(node => node.getAttribute('data-docs-animation'))).toEqual([
      'files-settings-open', 'files-settings-files', 'files-settings-choose', 'files-settings-copy', 'files-settings-manage',
    ]);
    expect(article?.querySelector('[data-testid="files-settings-step-files"]')?.textContent).toContain(s.saved_files_heading);
    expect(article?.querySelector('[data-testid="files-settings-step-files"] .files-focus')?.textContent).toContain(s.example_filename);
    expect(article?.querySelector('[data-testid="files-settings-step-files"] .files-focus')?.textContent).toContain(s.download_action);
    expect(article?.querySelector('#files-settings-files')?.parentElement?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/wesh-sysfs/`);
    expect(article?.querySelector('[data-testid="files-settings-step-manage"]')?.textContent).toContain(s.in_use_globally);
    expect(article?.querySelector('[data-testid="files-settings-step-copy"]')?.textContent).toContain(s.copied_status);
    expect(article?.querySelector('[data-testid="files-settings-step-manage"]')?.textContent).toContain(s.copied_status);
    expect(article?.textContent).toContain(s.after_adding_a_folder);
    expect(article?.querySelectorAll('figure button, figure input, figure a')).toHaveLength(0);
    expect([...article?.querySelectorAll('[data-docs-related-guide] a') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/file-access/`, `/docs/${locale}/tool-browser-shell/`,
    ]);
  });
});
