import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import LlamaGuide from '../pages/endpoint-type-llama-cpp-browser/index.vue';
import TransformersGuide from '../pages/endpoint-type-transformers-js/index.vue';
import BrowserModelsGuide from '../pages/in-browser-models/index.vue';
import { messages as llamaEnglish } from '../pages/endpoint-type-llama-cpp-browser/messages/en';
import { messages as llamaJapanese } from '../pages/endpoint-type-llama-cpp-browser/messages/ja';
import { messages as transformersEnglish } from '../pages/endpoint-type-transformers-js/messages/en';
import { messages as transformersJapanese } from '../pages/endpoint-type-transformers-js/messages/ja';
import { messages as overviewEnglish } from '../pages/in-browser-models/messages/en';
import { messages as overviewJapanese } from '../pages/in-browser-models/messages/ja';
import { messages as commonEnglish } from '../messages/common/en';
import { messages as commonJapanese } from '../messages/common/ja';
import { parsePage } from './site.test-support';

// README's Text Generation model links are the source of this guide's shortlist.
const readmeTextModels = [
  ['Gemma 4 E2B it', 'hf.co/google/gemma-4-E2B-it-qat-q4_0-gguf:Q4_0'],
  ['Gemma 4 E4B it', 'hf.co/google/gemma-4-E4B-it-qat-q4_0-gguf:Q4_0'],
  ['Gemma 4 26B-A4B it', 'hf.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf:Q4_0'],
  ['gpt-oss-20b', 'hf.co/ggml-org/gpt-oss-20b-GGUF:MXFP4'],
  ['Qwen3.5 9B', 'hf.co/lmstudio-community/Qwen3.5-9B-GGUF:Q4_K_M'],
  ['Qwen3.6 35B-A3B', 'hf.co/ggml-org/Qwen3.6-35B-A3B-GGUF:Q4_K_M'],
  ['Qwen3.8 27B', 'hf.co/ggml-org/Qwen3.8-27B-GGUF:Q4_K_M'],
  ['LFM2.5 230M', 'hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M'],
  ['LFM2.5 2.6B', 'hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M'],
  ['Muse-Glimmer 30B', 'hf.co/meta-models/Muse-Glimmer-30B-GGUF:Q4_K_M'],
  ['SmolLM2 135M Instruct', 'hf.co/lmstudio-community/SmolLM2-135M-Instruct-GGUF:Q4_K_M'],
] as const;

describe('browser model guides', () => {
  it.each([
    { locale: 'en', s: llamaEnglish, common: commonEnglish },
    { locale: 'ja', s: llamaJapanese, common: commonJapanese },
  ] as const)('keeps import and download as separate routes to an explicit llama.cpp default in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(LlamaGuide, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-models-llama-cpp-browser"]');
    const modelLinks = [...(article?.querySelectorAll('.quick-model-list a') ?? [])];
    expect(modelLinks.map(link => {
      const hash = new URL(link.getAttribute('href') ?? '').hash;
      expect(hash.startsWith('#/?llama-cpp-browser-model=')).toBe(true);
      expect(link.querySelector('[data-docs-external-icon], .sr-only')).toBeNull();
      return [link.textContent?.trim(), new URLSearchParams(hash.slice(3)).get('llama-cpp-browser-model')];
    })).toEqual(readmeTextModels);
    expect(article?.querySelectorAll('section.walkthrough-step')).toHaveLength(4);
    for (const stage of ['open', 'import', 'download', 'default']) {
      const scene = article?.querySelector(`[data-testid="llama-settings-${stage}"]`);
      expect(scene?.getAttribute('data-docs-animation')).toBe(`llama-settings-${stage}`);
      expect(scene?.querySelector('[data-docs-camera-canvas]')).not.toBeNull();
    }
    expect(article?.querySelector('[data-testid="llama-settings-import"]')?.textContent).toContain(s.choose_gguf_files);
    expect(article?.querySelector('[data-testid="llama-settings-import"] .imported-result')?.textContent).toContain(s.sample_model_id);
    expect([...article?.querySelectorAll('.import-modes > span') ?? []].map(mode => mode.textContent?.trim())).toEqual([s.save_in_browser, s.link_folder, s.use_temporarily]);
    expect(article?.querySelector('.import-modes .selected')?.textContent).toContain(s.save_in_browser);
    expect(article?.querySelectorAll('.storage-choices li')).toHaveLength(3);
    expect(article?.querySelector('[data-testid="llama-settings-download"]')?.textContent).toContain(s.check_model);
    expect(article?.querySelector('[data-testid="llama-settings-download"]')?.textContent).toContain(s.download_destination);
    expect(article?.querySelector('[data-testid="llama-settings-download"]')?.textContent).toContain(s.imported_models);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .repository-search')?.textContent).toContain(s.find_models);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .model-row.downloaded-result')?.textContent).toContain(s.downloaded_model_id);
    expect(article?.querySelector('[data-testid="llama-settings-default"]')?.textContent).toContain(s.confirm_default_model);
    expect(article?.querySelector('[data-testid="llama-settings-default"] .previous-download-result')?.textContent).toContain(s.downloaded_model_id);
    expect(article?.querySelector('[data-testid="llama-settings-default"] .confirm-panel')?.textContent).toContain(s.default_model_scope);
    expect(article?.textContent).toContain(locale === 'en' ? 'Standalone' : 'スタンドアロン');
    expect(article?.textContent).toContain('JSPI');
    expect(article?.textContent).toContain(locale === 'en' ? 'Run in your browser' : 'ブラウザ内で動かす');
    expect(article?.textContent).not.toContain(locale === 'en' ? 'Start with this model' : 'このモデルで始める');
    expect(article?.querySelector('.app-entry-onboarding')).toBeNull();
    expect(article?.querySelector('button, input, select, script')).toBeNull();
  });

  it.each([
    { locale: 'en', s: transformersEnglish, common: commonEnglish },
    { locale: 'ja', s: transformersJapanese, common: commonJapanese },
  ] as const)('shows automatic post-download load and distinct later Load and Resume actions in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(TransformersGuide, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-models-transformers-js"]');
    const launch = article?.querySelector<HTMLAnchorElement>('a[data-docs-app-entry-path]');
    expect(launch?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/settings/transformers-js');
    expect(launch?.textContent).toBe('/#/settings/transformers-js');
    expect(launch?.querySelector('[data-docs-external-icon], .sr-only')).toBeNull();
    expect(article?.querySelector('.app-entry-onboarding')).toBeNull();
    expect(article?.querySelectorAll('section.walkthrough-step')).toHaveLength(4);
    for (const stage of ['open', 'download', 'resume', 'save']) {
      const scene = article?.querySelector(`[data-testid="transformers-settings-${stage}"]`);
      expect(scene?.getAttribute('data-docs-animation')).toBe(`transformers-settings-${stage}`);
      expect(scene?.querySelector('[data-docs-camera-canvas]')).not.toBeNull();
    }
    const download = article?.querySelector('[data-testid="transformers-settings-download"]');
    expect(download?.textContent).toContain(s.download_model);
    expect(download?.textContent).toContain(s.loading_from_local_storage);
    expect(download?.textContent).toContain(s.engine_ready);
    const later = article?.querySelector('[data-testid="transformers-settings-resume"]');
    expect(later?.textContent).toContain(s.load);
    expect(later?.textContent).toContain(s.resume);
    expect(later?.textContent).toContain(s.incomplete);
    const save = article?.querySelector('[data-testid="transformers-settings-save"]');
    expect(save?.querySelector('.manager-before-save')?.textContent).toContain(s.downloaded_models);
    expect([...save?.querySelectorAll('.connection-setup .connection-label') ?? []].map(label => label.textContent)).toEqual([s.connection, s.default_model]);
    expect(save?.querySelector('.connection-model-controls')?.textContent).toContain(s.manage_models);
    expect(save?.textContent).not.toContain(locale === 'en' ? 'API Provider' : 'API プロバイダー');
    expect(save?.textContent).not.toContain(locale === 'en' ? 'Endpoint Configuration' : 'エンドポイント設定');
    expect(save?.textContent).not.toContain('Endpoint URL');
    expect(article?.textContent).toContain(locale === 'en' ? 'Standalone' : 'スタンドアロン');
    expect(article?.textContent).toContain('OPFS');
    expect(article?.querySelector('.import-modes')).toBeNull();
    expect(article?.querySelector('button, input, select, script')).toBeNull();
  });

  it.each([
    { locale: 'en', s: overviewEnglish, common: commonEnglish },
    { locale: 'ja', s: overviewJapanese, common: commonJapanese },
  ] as const)('provides a direct GGUF start while keeping the other engines on their own guides in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(BrowserModelsGuide, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-models-in-browser"]');
    expect(article?.querySelector('.app-entry-intro a')?.getAttribute('href')).toBe('https://naidan.nwtgck.org/#/');
    expect([...article?.querySelectorAll('.card-guide-link') ?? []].map(link => link.getAttribute('href'))).toEqual([
      `/docs/${locale}/endpoint-type-llama-cpp-browser/`,
      `/docs/${locale}/endpoint-type-transformers-js/`,
      `/docs/${locale}/endpoint-type-browser-provided-lm/`,
    ]);
    const steps = article?.querySelectorAll('.guide-steps > li');
    expect(steps).toHaveLength(4);
    expect(steps?.[0]?.querySelector('h3')?.textContent).toBe(s.select_llama_cpp_heading);
    expect(steps?.[1]?.textContent).toContain(locale === 'en' ? 'Run in your browser' : 'ブラウザ内で動かす');
    expect(steps?.[1]?.textContent).toContain('OPFS');
    expect(article?.querySelector('button, input, select, script')).toBeNull();
  });
});
