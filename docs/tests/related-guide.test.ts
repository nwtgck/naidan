import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import BranchingPage from '../pages/chat/branching.vue';
import RelatedGuide from '../site/RelatedGuide.vue';
import { strings as branchingEn } from '../strings/chat/branching/en';
import { strings as branchingJa } from '../strings/chat/branching/ja';
import { strings as english } from '../strings/common/en';
import { strings as japanese } from '../strings/common/ja';
import { parsePage } from './site.test-support';

describe('related guide links', () => {
  it.each([
    { locale: 'en' as const, common: english, titles: ['Set up Ollama', 'Run in the browser'], descriptions: ['Connect a local model.', 'Choose a browser runtime.'] },
    { locale: 'ja' as const, common: japanese, titles: ['Ollamaを設定する', 'ブラウザ内で動かす'], descriptions: ['ローカルモデルに接続します。', 'ブラウザ内の実行方式を選びます。'] },
  ])('renders multiple $locale guides as complete normal links', async ({ locale, common, titles, descriptions }) => {
    const html = await renderToString(createSSRApp({
      render: () => h(RelatedGuide, {
        locale,
        eyebrow: common.relatedGuides,
        guides: [
          { page: 'models/ollama', title: titles[0] ?? '', description: descriptions[0] ?? '' },
          { page: 'models/in-browser', title: titles[1] ?? '', description: descriptions[1] ?? '' },
        ],
      }),
    }));
    using page = parsePage({ html });
    const nav = page.document.querySelector('[data-docs-related-guide]');
    expect(nav?.tagName).toBe('NAV');
    expect(nav?.getAttribute('aria-label')).toBe(common.relatedGuides);
    const links = [...(nav?.querySelectorAll('a') ?? [])];
    expect(links.map(link => link.getAttribute('href'))).toEqual([`/docs/${locale}/models/ollama/`, `/docs/${locale}/models/in-browser/`]);
    for (const [index, link] of links.entries()) {
      expect(link.textContent).toContain(titles[index]);
      expect(link.textContent).toContain(descriptions[index]);
      expect(link.querySelector('[aria-hidden="true"]')?.textContent).toBe('→');
    }
    expect(links.every(link => link.getAttribute('target') === null)).toBe(true);
  });

  it.each([
    { locale: 'en' as const, common: english, copy: branchingEn },
    { locale: 'ja' as const, common: japanese, copy: branchingJa },
  ])('takes the $locale branching reader to the whole-path editing guide', async ({ locale, common, copy }) => {
    const html = await renderToString(createSSRApp(BranchingPage, { locale, common, s: copy }));
    using page = parsePage({ html });
    const related = page.document.querySelector('[data-docs-related-guide]');
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/chat/super-edit/`);
    expect(related?.textContent).toContain(copy.next);
    expect(related?.textContent).toContain(copy.nextDescription);
  });
});
