import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import BranchingPage from '../pages/chat-branching/index.vue';
import StandalonePage from '../pages/standalone/index.vue';
import RelatedGuide from '../components/RelatedGuide.vue';
import { messages as branchingEn } from '../pages/chat-branching/messages/en';
import { messages as branchingJa } from '../pages/chat-branching/messages/ja';
import { messages as english } from '../messages/common/en';
import { messages as japanese } from '../messages/common/ja';
import { messages as standaloneEn } from '../pages/standalone/messages/en';
import { messages as standaloneJa } from '../pages/standalone/messages/ja';
import { parsePage } from './site.test-support';

describe('related guide links', () => {
  it.each([
    { locale: 'en' as const, common: english, titles: ['Set up Ollama', 'Run in the browser'], descriptions: ['Connect a local model.', 'Choose a browser runtime.'] },
    { locale: 'ja' as const, common: japanese, titles: ['Ollamaを設定する', 'ブラウザ内で動かす'], descriptions: ['ローカルモデルに接続します。', 'ブラウザ内の実行方式を選びます。'] },
  ])('renders multiple $locale guides as complete normal links', async ({ locale, common, titles, descriptions }) => {
    const html = await renderToString(createSSRApp({
      render: () => h(RelatedGuide, {
        locale,
        eyebrow: common.related_guides,
        guides: [
          { page: 'endpoint-type-ollama', title: titles[0] ?? '', description: descriptions[0] ?? '' },
          { page: 'in-browser-models', title: titles[1] ?? '', description: descriptions[1] ?? '' },
        ],
      }),
    }));
    using page = parsePage({ html });
    const nav = page.document.querySelector('[data-docs-related-guide]');
    expect(nav?.tagName).toBe('NAV');
    expect(nav?.getAttribute('aria-label')).toBe(common.related_guides);
    const links = [...(nav?.querySelectorAll('a') ?? [])];
    expect(links.map(link => link.getAttribute('href'))).toEqual([`/docs/${locale}/endpoint-type-ollama/`, `/docs/${locale}/in-browser-models/`]);
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
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/chat-super-edit/`);
    expect(related?.textContent).toContain(copy.rewrite_a_conversation_path);
    expect(related?.textContent).toContain(copy.edit_and_reorder_a_path);
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
      `/docs/${locale}/pwa/`,
      `/docs/${locale}/hosted/`,
      `/docs/${locale}/web-and-native-app-permissions/`,
      `/docs/${locale}/browser-boundaries/`,
    ]);
    expect(links[0]?.textContent).toContain(copy.offline_pwa_guide_title);
    expect(links[0]?.textContent).toContain(copy.offline_pwa_guide_description);
    expect(links[1]?.textContent).toContain(copy.hosted_zip_guide_title);
    expect(links[1]?.textContent).toContain(copy.hosted_zip_guide_description);
    expect(links[2]?.textContent).toContain(copy.app_permissions_guide_title);
    expect(links[2]?.textContent).toContain(copy.app_permissions_guide_description);
    expect(links[3]?.textContent).toContain(copy.browser_boundaries_guide_title);
    expect(links[3]?.textContent).toContain(copy.browser_boundaries_guide_description);
  });
});
