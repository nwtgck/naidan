import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import BranchingPage from '../pages/chat/branching.vue';
import StandalonePage from '../pages/run/standalone.vue';
import RelatedGuide from '../site/RelatedGuide.vue';
import { strings as branchingEn } from '../strings/chat/branching/en';
import { strings as branchingJa } from '../strings/chat/branching/ja';
import { strings as english } from '../strings/common/en';
import { strings as japanese } from '../strings/common/ja';
import { strings as standaloneEn } from '../strings/run/standalone/en';
import { strings as standaloneJa } from '../strings/run/standalone/ja';
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

  it.each([
    { locale: 'en' as const, common: english, copy: standaloneEn },
    { locale: 'ja' as const, common: japanese, copy: standaloneJa },
  ])('connects the $locale Standalone guide to offline use and access boundaries', async ({ locale, common, copy }) => {
    const html = await renderToString(createSSRApp(StandalonePage, { locale, common, s: copy }));
    using page = parsePage({ html });
    const related = page.document.querySelector('[data-docs-related-guide]');
    const links = [...(related?.querySelectorAll('a') ?? [])];
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/run/offline/`,
      `/docs/${locale}/work/app-permissions/`,
      `/docs/${locale}/work/boundary/`,
    ]);
    expect(links[0]?.textContent).toContain(copy.offlineGuideTitle);
    expect(links[0]?.textContent).toContain(copy.offlineGuideDescription);
    expect(links[1]?.textContent).toContain(copy.permissionsGuideTitle);
    expect(links[1]?.textContent).toContain(copy.permissionsGuideDescription);
    expect(links[2]?.textContent).toContain(copy.next);
    expect(links[2]?.textContent).toContain(copy.nextDescription);
  });
});
