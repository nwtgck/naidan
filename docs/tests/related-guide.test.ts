import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it } from 'vitest';
import BranchingPage from '../pages/chat-branching/index.vue';
import StandalonePage from '../pages/standalone/index.vue';
import RelatedGuide from '../site/RelatedGuide.vue';
import { strings as branchingEn } from '../pages/chat-branching/strings/en';
import { strings as branchingJa } from '../pages/chat-branching/strings/ja';
import { strings as english } from '../strings/common/en';
import { strings as japanese } from '../strings/common/ja';
import { strings as standaloneEn } from '../pages/standalone/strings/en';
import { strings as standaloneJa } from '../pages/standalone/strings/ja';
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
          { page: 'endpoint-type-ollama', title: titles[0] ?? '', description: descriptions[0] ?? '' },
          { page: 'in-browser-models', title: titles[1] ?? '', description: descriptions[1] ?? '' },
        ],
      }),
    }));
    using page = parsePage({ html });
    const nav = page.document.querySelector('[data-docs-related-guide]');
    expect(nav?.tagName).toBe('NAV');
    expect(nav?.getAttribute('aria-label')).toBe(common.relatedGuides);
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
      `/docs/${locale}/pwa/`,
      `/docs/${locale}/hosted/`,
      `/docs/${locale}/web-and-native-app-permissions/`,
      `/docs/${locale}/browser-boundaries/`,
    ]);
    expect(links[0]?.textContent).toContain(copy.offlineGuideTitle);
    expect(links[0]?.textContent).toContain(copy.offlineGuideDescription);
    expect(links[1]?.textContent).toContain(copy.hostedGuideTitle);
    expect(links[1]?.textContent).toContain(copy.hostedGuideDescription);
    expect(links[2]?.textContent).toContain(copy.permissionsGuideTitle);
    expect(links[2]?.textContent).toContain(copy.permissionsGuideDescription);
    expect(links[3]?.textContent).toContain(copy.next);
    expect(links[3]?.textContent).toContain(copy.nextDescription);
  });
});
