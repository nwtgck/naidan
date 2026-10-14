import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import OpenAiCompatibleGuide from '../pages/models/openai-compatible.vue';
import BrowserProvidedGuide from '../pages/models/browser-provided.vue';
import { strings as openAiEn } from '../strings/models/openai-compatible/en';
import { strings as openAiJa } from '../strings/models/openai-compatible/ja';
import { strings as browserEn } from '../strings/models/browser-provided/en';
import { strings as browserJa } from '../strings/models/browser-provided/ja';
import { checkerCopy } from '../islands/browser-ai-availability/copy';
import { parsePage } from './site.test-support';
import type { CommonMessages } from '../site/messages';
import type { DocsLocale } from '../site/routes';

async function renderGuide({ kind, locale }: { kind: 'openai' | 'browser'; locale: DocsLocale }) {
  const common = {} as CommonMessages;
  const html = kind === 'openai'
    ? await renderToString(createSSRApp({ render: () => h(OpenAiCompatibleGuide, { s: locale === 'en' ? openAiEn : openAiJa, locale, common }) }))
    : await renderToString(createSSRApp({ render: () => h(BrowserProvidedGuide, { s: locale === 'en' ? browserEn : browserJa, locale, common }) }));
  return parsePage({ html });
}

describe('endpoint connection guides', () => {
  it.each(['en', 'ja'] as const)('places each OpenAI-compatible action beside its scene in %s', async locale => {
    using page = await renderGuide({ kind: 'openai', locale });
    const launch = page.document.querySelector<HTMLAnchorElement>('[data-docs-app-entry-path]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    expect(launch?.textContent).toBe('Naidan');
    const sections = [...page.document.querySelectorAll('article section.walkthrough-step')];
    expect(sections).toHaveLength(5);
    expect(sections.map(section => section.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'openai-compatible-open',
      'openai-compatible-provider',
      'openai-compatible-headers',
      'openai-compatible-check',
      'openai-compatible-model',
    ]);
    for (const section of sections) {
      expect(section.children[0]?.tagName).toBe('H2');
      expect(section.children[1]?.tagName).toBe('P');
      expect(section.children[2]?.tagName).toBe('FIGURE');
      expect(section.querySelector('figcaption')?.textContent?.trim()).toBeTruthy();
    }
    const scenes = sections.map(section => section.querySelector('[data-docs-animation]')?.textContent ?? '');
    const copy = locale === 'en' ? openAiEn.demo : openAiJa.demo;
    expect(sections[0]?.querySelector('.provider-before')?.textContent).toBe(copy.ollama);
    expect(sections[0]?.querySelector('.ollama-preset')).not.toBeNull();
    expect(sections[1]?.querySelector('.provider-after')?.textContent).toBe(copy.openaiCompatible);
    expect(sections[1]?.querySelector('.provider-option-target')?.textContent).toContain(copy.openaiCompatible);
    expect(scenes[1]).toContain(copy.lmStudioPreset);
    expect(scenes[1]).toContain('http://localhost:1234/v1');
    expect(scenes[2]).toContain(copy.customHttpHeaders);
    expect(scenes[2]).toContain(copy.headerName);
    expect(scenes[2]).toContain(copy.headerValue);
    expect(scenes[3]).toContain(copy.checkConnection);
    expect(scenes[4]).toContain(copy.defaultModel);
    for (const section of sections) {
      expect(section.querySelector('.settings-modal .modal-tabs .tab.selected')?.textContent).toContain(copy.connection);
      expect(section.querySelector('.settings-modal .modal-main .modal-footer')).not.toBeNull();
    }
  });

  it.each(['en', 'ja'] as const)('shows the browser-managed choice and conditional preparation in %s', async locale => {
    using page = await renderGuide({ kind: 'browser', locale });
    const article = page.document.querySelector('article');
    const guide = locale === 'en' ? browserEn : browserJa;
    const concept = article?.querySelector('.concept-section');
    const flow = concept?.querySelector('[data-docs-animation="chrome-model-flow"]');
    expect(concept?.querySelector('h2')?.textContent).toBe(guide.flow.title);
    expect(flow?.querySelector('.chrome-flow-question')?.textContent?.trim()).toBe(guide.flow.demo.question);
    expect(flow?.querySelector('.chrome-flow-answer')?.textContent?.trim()).toBe(guide.flow.demo.answer);
    expect(flow?.querySelector('.chrome-flow-provider')?.textContent).toBe(guide.flow.demo.provider);
    expect(flow?.querySelectorAll('.chrome-flow-chunk').length).toBeGreaterThan(1);
    expect(concept?.querySelector('figcaption')?.textContent).toBe(guide.flow.caption);
    const checker = concept?.nextElementSibling;
    expect(checker?.getAttribute('data-docs-island')).toBe('browser-ai-availability');
    expect(checker?.querySelector('h2')?.textContent).toBe(checkerCopy[locale].title);
    const requirements = checker?.nextElementSibling;
    expect(requirements?.tagName).toBe('DETAILS');
    expect(requirements?.hasAttribute('open')).toBe(false);
    expect(requirements?.querySelector('summary')?.textContent).toBe(guide.requirementsSummary);
    expect(requirements?.textContent).toContain(guide.before);
    expect(requirements?.textContent).toContain(guide.languageSupport);
    expect([...requirements?.querySelectorAll('[data-docs-external]') ?? []].map(link => link.getAttribute('href'))).toEqual([
      'https://developer.chrome.com/docs/ai/prompt-api',
      'https://developer.chrome.com/docs/ai/get-started',
    ]);
    const sections = [...page.document.querySelectorAll('article section.walkthrough-step')];
    expect(sections).toHaveLength(4);
    expect(sections.map(section => section.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'browser-provided-open',
      'browser-provided-select',
      'browser-provided-prepare',
      'browser-provided-save',
    ]);
    const copy = guide.demo;
    expect(sections[0]?.querySelector('.provider-before')?.textContent).toBe(copy.ollama);
    expect(sections[1]?.querySelector('.provider-after')?.textContent).toBe(copy.browserProvided);
    expect(sections[1]?.querySelector('.provider-option-target')?.textContent).toContain(copy.browserProvided);
    expect(sections[1]?.textContent).toContain(copy.browserProvided);
    expect(sections[2]?.textContent).toContain(copy.prepare);
    expect(sections[2]?.textContent).toContain(copy.ready);
    expect(sections[3]?.querySelector('.disabled-model')?.textContent).toContain(copy.modelId);
    for (const section of sections) {
      expect(section.children[0]?.tagName).toBe('H2');
      expect(section.children[1]?.tagName).toBe('P');
      expect(section.children[2]?.tagName).toBe('FIGURE');
      expect(section.querySelector('figcaption')?.textContent?.trim()).toBeTruthy();
      expect(section.querySelector('.settings-modal .modal-tabs .tab.selected')?.textContent).toContain(copy.connection);
      expect(section.querySelector('.settings-modal .modal-main .modal-footer')).not.toBeNull();
    }
  });
});
