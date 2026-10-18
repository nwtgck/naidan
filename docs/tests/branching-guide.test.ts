import { readBranchingMessages } from '../islands/branching/messages';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import BranchingPage from '../pages/chat-branching/index.vue';
import { messages as english } from '../pages/chat-branching/messages/en';
import { messages as japanese } from '../pages/chat-branching/messages/ja';
import { messages as englishCommon } from '../messages/common/en';
import { messages as japaneseCommon } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('conversation branching guide', () => {
  it.each([
    { locale: 'en' as const, copy: english, common: englishCommon, update: 'Update & Branch' },
    { locale: 'ja' as const, copy: japanese, common: japaneseCommon, update: '更新して分岐' },
  ])('marks actual $locale control names in server-rendered prose and captions', async ({ locale, copy, common, update }) => {
    const html = await renderToString(createSSRApp(BranchingPage, { s: copy, locale, common }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-branching"]');
    if (!article) {
      throw new Error('Missing branching guide');
    }
    expect(article.querySelector('.app-entry-intro a[data-docs-app-entry-path="/#/"]')?.textContent).toBe('Naidan');
    expect(article.querySelector('.app-entry-intro a[href] + a')?.getAttribute('href')).toBe(`/docs/${locale}/in-browser-models/`);
    const demo = readBranchingMessages({ locale }).messages;
    const labels = [...article.querySelectorAll('.ui-label')].map(element => element.textContent);
    for (const expected of [demo.ui.sendAndBranch, demo.ui.moreActions, demo.ui.fork, demo.controls.replay, update]) {
      expect(labels).toContain(expected);
    }
    expect(article.querySelector('ol .ui-label')?.textContent).toBe(demo.ui.sendAndBranch);
    expect(article.querySelector('.caption-reserve .ui-label')).not.toBeNull();
    expect(article.textContent).not.toContain('［');
    expect(article.textContent).not.toContain('］');
    for (const label of article.querySelectorAll('.ui-label')) {
      expect(label.closest('a, kbd')).toBeNull();
      const button = label.closest('button');
      if (button) {
        expect(button.matches('[data-testid^="branch-step-"]')).toBe(true);
        expect(label.closest('.sr-only')).not.toBeNull();
      }
    }
    expect(article.querySelector('[data-docs-related-guide] a')?.getAttribute('href')).toBe(`/docs/${locale}/chat-super-edit/`);
  });
});
