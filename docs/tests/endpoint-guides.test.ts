import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import OpenAiCompatibleGuide from '../pages/endpoint-type-openai/index.vue';
import BrowserProvidedGuide from '../pages/endpoint-type-browser-provided-lm/index.vue';
import LocalEnginesGuide from '../pages/local-ai-servers/index.vue';
import { messages as openAiEn } from '../pages/endpoint-type-openai/messages/en';
import { messages as openAiJa } from '../pages/endpoint-type-openai/messages/ja';
import { messages as browserEn } from '../pages/endpoint-type-browser-provided-lm/messages/en';
import { messages as browserJa } from '../pages/endpoint-type-browser-provided-lm/messages/ja';
import { messages as localEnginesEn } from '../pages/local-ai-servers/messages/en';
import { messages as localEnginesJa } from '../pages/local-ai-servers/messages/ja';
import { readBrowserAiMessages } from '../islands/browser-ai-availability/messages';
import { parsePage } from './site.test-support';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import type { DocsLocale } from '../navigation/routes';

async function renderGuide({ kind, locale }: { kind: 'openai' | 'browser'; locale: DocsLocale }) {
  const common = locale === 'en' ? commonEn : commonJa;
  const html = kind === 'openai'
    ? await renderToString(createSSRApp({ render: () => h(OpenAiCompatibleGuide, { s: locale === 'en' ? openAiEn : openAiJa, locale, common }) }))
    : await renderToString(createSSRApp({ render: () => h(BrowserProvidedGuide, { s: locale === 'en' ? browserEn : browserJa, locale, common }) }));
  return parsePage({ html });
}

describe('endpoint connection guides', () => {
  it.each(['en', 'ja'] as const)('starts the local-engine overview at saved connection settings in %s', async locale => {
    const html = await renderToString(createSSRApp({
      render: () => h(LocalEnginesGuide, {
        s: locale === 'en' ? localEnginesEn : localEnginesJa,
        locale,
        common: locale === 'en' ? commonEn : commonJa,
      }),
    }));
    using page = parsePage({ html });
    const article = page.document.querySelector('article');
    expect(article?.querySelector('[data-docs-app-entry-path]')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/settings/connection');
    expect([...article?.querySelectorAll('.card-guide-link') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/endpoint-type-ollama/`, `/docs/${locale}/endpoint-type-openai/`,
    ]);
    const labels = [...article?.querySelectorAll('.ui-label') ?? []].map(label => label.textContent);
    const connection = locale === 'en' ? openAiEn : openAiJa;
    expect(labels).toEqual(expect.arrayContaining([connection.connection, connection.default_model, connection.save_changes, connection.new_chat]));
    expect(labels).not.toEqual(expect.arrayContaining([locale === 'en' ? 'Get Started' : '始める']));
    expect(article?.textContent).not.toMatch(/first-run setup|初回設定|API Provider|API プロバイダー|Endpoint Configuration|エンドポイント設定|Model Selection|モデル選択/);
  });

  it.each(['en', 'ja'] as const)('places each OpenAI-compatible action beside its scene in %s', async locale => {
    using page = await renderGuide({ kind: 'openai', locale });
    const launch = page.document.querySelector<HTMLAnchorElement>('[data-docs-app-entry-path]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/settings/connection');
    expect(launch?.textContent).toBe('/#/settings/connection');
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
    const copy = locale === 'en' ? openAiEn : openAiJa;
    expect(sections[0]?.querySelector('.provider-before')?.textContent).toBe(copy.ollama);
    expect(sections[0]?.querySelector('.ollama-preset')).not.toBeNull();
    expect(sections[1]?.querySelector('.provider-after')?.textContent).toBe(copy.openai_compatible);
    expect(sections[1]?.querySelector('.provider-option-target')?.textContent).toContain(copy.openai_compatible);
    expect(scenes[1]).toContain(copy.lm_studio_local_preset);
    expect(scenes[1]).toContain('http://localhost:1234/v1');
    expect(scenes[2]).toContain(copy.custom_http_headers);
    expect(scenes[2]).toContain(copy.sample_header_name);
    expect(scenes[2]).toContain(copy.sample_header_value);
    expect(scenes[3]).toContain(copy.check_connection);
    expect(scenes[4]).toContain(copy.default_model);
    for (const section of sections) {
      expect(section.querySelector('.connection-layout > .provider-field')).not.toBeNull();
      expect(section.querySelector('.connection-layout > .model-section')).not.toBeNull();
      expect(section.querySelector('.connection-details .headers-disclosure')).not.toBeNull();
    }
    expect(sections[3]?.querySelector('.check-done')?.textContent).toBe(copy.check_connection);
    expect(page.document.querySelector('article')?.textContent).not.toMatch(/first-run setup|初回設定/);
    for (const section of sections) {
      expect(section.querySelector('.settings-modal .modal-tabs .tab.selected')?.textContent).toContain(copy.connection);
      expect(section.querySelector('.settings-modal .modal-main .modal-footer')).not.toBeNull();
    }
  });

  it.each(['en', 'ja'] as const)('shows the browser-managed choice and conditional preparation in %s', async locale => {
    using page = await renderGuide({ kind: 'browser', locale });
    const article = page.document.querySelector('article');
    expect(article?.querySelector('[data-docs-app-entry-path]')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/settings/connection');
    expect(article?.textContent).not.toMatch(/first-run setup|初回設定/);
    const guide = locale === 'en' ? browserEn : browserJa;
    const concept = article?.querySelector('.concept-section');
    const flow = concept?.querySelector('[data-docs-animation="chrome-model-flow"]');
    expect(concept?.querySelector('h2')?.textContent).toBe(guide.chrome_model_flow_heading);
    expect(flow?.querySelector('.chrome-flow-question')?.textContent?.trim()).toBe(guide.your_question);
    expect(flow?.querySelector('.chrome-flow-answer')?.textContent?.trim()).toBe(guide.answer);
    expect(flow?.querySelector('.chrome-flow-provider')?.textContent).toBe(guide.browser_provided_model_label);
    expect(flow?.querySelectorAll('.chrome-flow-chunk').length).toBeGreaterThan(1);
    expect(concept?.querySelector('figcaption')?.textContent).toBe(guide.chrome_model_flow_caption);
    const checker = concept?.nextElementSibling;
    expect(checker?.getAttribute('data-docs-island')).toBe('browser-ai-availability');
    expect(checker?.querySelector('h2')?.textContent).toBe(readBrowserAiMessages({ locale }).check_this_browser_heading);
    const requirements = checker?.nextElementSibling;
    expect(requirements?.tagName).toBe('DETAILS');
    expect(requirements?.hasAttribute('open')).toBe(false);
    expect(requirements?.querySelector('summary')?.textContent).toBe(guide.chrome_requirements_heading);
    expect(requirements?.textContent).toContain(guide.chrome_device_requirements);
    expect(requirements?.textContent).toContain(guide.japanese_language_support);
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
    const copy = guide;
    expect(sections[0]?.querySelector('.provider-before')?.textContent).toBe(copy.ollama);
    expect(sections[1]?.querySelector('.provider-after')?.textContent).toBe(copy.browser_provided_provider_option);
    expect(sections[1]?.querySelector('.provider-option-target')?.textContent).toContain(copy.browser_provided_provider_option);
    expect(sections[1]?.textContent).toContain(copy.browser_provided_provider_option);
    expect(sections[2]?.textContent).toContain(copy.prepare_browser_model);
    expect(sections[2]?.textContent).toContain(copy.browser_model_ready);
    expect(sections[3]?.querySelector('.disabled-model')?.textContent).toContain(copy.browser_model_id);
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
