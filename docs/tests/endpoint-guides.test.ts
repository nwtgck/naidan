import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import OpenAiCompatibleGuide from '../pages/models/openai-compatible.vue';
import BrowserProvidedGuide from '../pages/models/browser-provided.vue';
import { strings as openAiEn } from '../strings/models/openai-compatible/en';
import { strings as openAiJa } from '../strings/models/openai-compatible/ja';
import { strings as browserEn } from '../strings/models/browser-provided/en';
import { strings as browserJa } from '../strings/models/browser-provided/ja';
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
    expect(launch?.textContent).toBe('/#/');
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
    const sections = [...page.document.querySelectorAll('article section.walkthrough-step')];
    expect(sections).toHaveLength(4);
    expect(sections.map(section => section.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'browser-provided-open',
      'browser-provided-select',
      'browser-provided-prepare',
      'browser-provided-save',
    ]);
    const copy = locale === 'en' ? browserEn.demo : browserJa.demo;
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
