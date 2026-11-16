import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import FilesPage from '../pages/file-access/index.vue';
import { messages as english } from '../pages/file-access/messages/en';
import { messages as japanese } from '../pages/file-access/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('file access guide', () => {
  it.each([
    { locale: 'en', s: english, common: commonEnglish },
    { locale: 'ja', s: japanese, common: commonJapanese },
  ] as const)('keeps immediate access and unfinished saving visible in $locale HTML', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp(FilesPage, { locale, s, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-files"]');
    const progress = article?.querySelector('[data-testid="folder-copy-progress"]');
    expect(progress?.textContent).toContain(s.copying_available);
    expect(progress?.querySelector('.copying-state')?.textContent).toContain(s.copying_title);
    expect(progress?.querySelector('.paused-state')?.textContent).toContain(s.copy_paused_title);
    expect(progress?.querySelector('.copy-controls')?.textContent).toContain(s.pause_copy);
    expect(progress?.querySelector('.copy-controls')?.textContent).toContain(s.resume_copy);
    expect(article?.textContent).toContain(s.copying_lifetime);
    const steps = article?.querySelectorAll('ol > li');
    expect(steps).toHaveLength(5);
    expect(steps?.[1]?.textContent).toContain(locale === 'en' ? 'background' : 'バックグラウンド');
    expect(steps?.[1]?.textContent).toContain(locale === 'en' ? 'model that accepts image input' : '画像入力に対応するモデル');
    expect(article?.querySelector('.folder-target')?.textContent).toContain(s.read_only);
    expect(article?.querySelectorAll('figure button, figure input, figure a')).toHaveLength(0);
  });
});
