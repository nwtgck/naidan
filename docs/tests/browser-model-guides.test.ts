import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import LlamaGuide from '../pages/endpoint-type-llama-cpp-browser/index.vue';
import TransformersGuide from '../pages/endpoint-type-transformers-js/index.vue';
import { strings as llamaEnglish } from '../pages/endpoint-type-llama-cpp-browser/strings/en';
import { strings as llamaJapanese } from '../pages/endpoint-type-llama-cpp-browser/strings/ja';
import { strings as transformersEnglish } from '../pages/endpoint-type-transformers-js/strings/en';
import { strings as transformersJapanese } from '../pages/endpoint-type-transformers-js/strings/ja';
import { strings as commonEnglish } from '../strings/common/en';
import { strings as commonJapanese } from '../strings/common/ja';
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
    expect(article?.querySelector('[data-testid="llama-settings-import"]')?.textContent).toContain(s.demo.chooseFiles);
    expect(article?.querySelector('[data-testid="llama-settings-import"] .imported-result')?.textContent).toContain(s.demo.sampleFile);
    expect(article?.querySelector('[data-testid="llama-settings-download"]')?.textContent).toContain(s.demo.checkModel);
    expect(article?.querySelector('[data-testid="llama-settings-download"]')?.textContent).toContain(s.demo.downloadTo);
    expect(article?.querySelector('[data-testid="llama-settings-download"]')?.textContent).toContain(s.demo.importedModels);
    expect(article?.querySelector('[data-testid="llama-settings-download"] .model-row.downloaded-result')?.textContent).toContain(s.demo.sampleFile);
    expect(article?.querySelector('[data-testid="llama-settings-default"]')?.textContent).toContain(s.demo.confirmDefault);
    expect(article?.querySelector('[data-testid="llama-settings-default"] .previous-download-result')?.textContent).toContain(s.demo.sampleFile);
    expect(article?.querySelector('[data-testid="llama-settings-default"] .confirm-panel')?.textContent).toContain(s.demo.defaultScope);
    expect(article?.textContent).toContain(locale === 'en' ? 'Standalone' : 'スタンドアロン');
    expect(article?.textContent).toContain('JSPI');
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
    expect(article?.querySelector('.app-entry-onboarding')?.textContent).toContain('×');
    expect(article?.querySelector('.app-entry-onboarding .ui-label')?.textContent).toBe('Transformers.js');
    expect(article?.querySelectorAll('section.walkthrough-step')).toHaveLength(4);
    for (const stage of ['open', 'download', 'resume', 'save']) {
      const scene = article?.querySelector(`[data-testid="transformers-settings-${stage}"]`);
      expect(scene?.getAttribute('data-docs-animation')).toBe(`transformers-settings-${stage}`);
      expect(scene?.querySelector('[data-docs-camera-canvas]')).not.toBeNull();
    }
    const download = article?.querySelector('[data-testid="transformers-settings-download"]');
    expect(download?.textContent).toContain(s.demo.downloadModel);
    expect(download?.textContent).toContain(s.demo.loadingLocal);
    expect(download?.textContent).toContain(s.demo.engineReady);
    const later = article?.querySelector('[data-testid="transformers-settings-resume"]');
    expect(later?.textContent).toContain(s.demo.load);
    expect(later?.textContent).toContain(s.demo.resume);
    expect(later?.textContent).toContain(s.demo.incomplete);
    const save = article?.querySelector('[data-testid="transformers-settings-save"]');
    expect(save?.querySelector('.manager-before-save')?.textContent).toContain(s.demo.downloadedModels);
    expect(save?.textContent).toContain(s.demo.apiProvider);
    expect(save?.textContent).toContain(s.demo.defaultModel);
    expect(save?.textContent).not.toContain('Endpoint URL');
    expect(article?.textContent).toContain(locale === 'en' ? 'Standalone' : 'スタンドアロン');
    expect(article?.textContent).toContain('OPFS');
    expect(article?.querySelector('button, input, select, script')).toBeNull();
  });
});
