import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import LlamaGuide from '../pages/models/llama-cpp-browser.vue';
import TransformersGuide from '../pages/models/transformers-js.vue';
import { strings as llamaEnglish } from '../strings/models/llama-cpp-browser/en';
import { strings as llamaJapanese } from '../strings/models/llama-cpp-browser/ja';
import { strings as transformersEnglish } from '../strings/models/transformers-js/en';
import { strings as transformersJapanese } from '../strings/models/transformers-js/ja';
import { strings as commonEnglish } from '../strings/common/en';
import { strings as commonJapanese } from '../strings/common/ja';
import { parsePage } from './site.test-support';

describe('browser model guides', () => {
  it.each([
    { locale: 'en', s: llamaEnglish, common: commonEnglish },
    { locale: 'ja', s: llamaJapanese, common: commonJapanese },
  ] as const)('keeps import and download as separate routes to an explicit llama.cpp default in $locale', async ({ locale, s, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(LlamaGuide, { s, locale, common }) }));
    using page = parsePage({ html });
    const article = page.document.querySelector('[data-testid="docs-models-llama-cpp-browser"]');
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
