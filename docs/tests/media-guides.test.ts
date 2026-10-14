import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ImagePage from '../pages/images/create.vue';
import AudioPage from '../pages/audio/speech.vue';
import { strings as imageEn } from '../strings/images/create/en';
import { strings as imageJa } from '../strings/images/create/ja';
import { strings as audioEn } from '../strings/audio/speech/en';
import { strings as audioJa } from '../strings/audio/speech/ja';
import { strings as commonEn } from '../strings/common/en';
import { strings as commonJa } from '../strings/common/ja';
import { parsePage } from './site.test-support';
import { visibleGuideText } from './ui-label.test-support';

describe('media workflow guides', () => {
  it.each([{ copy: imageEn, locale: 'en', common: commonEn }, { copy: imageJa, locale: 'ja', common: commonJa }] as const)('renders every image step and its result as static HTML', async ({ copy, locale, common }) => {
    const html = await renderToString(createSSRApp(ImagePage, { s: copy, locale, common }));
    using page = parsePage({ html });
    expect(page.document.querySelector('article h1')?.textContent).toBe(copy.title);
    const steps = [...page.document.querySelectorAll('section.media-step')];
    expect(steps.map(step => step.querySelector('h2')?.textContent)).toEqual([
      copy.steps.open.title, copy.steps.model.title, copy.steps.generate.title, copy.steps.reuse.title,
    ]);
    expect(steps.map(step => step.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'image-open', 'image-model', 'image-generate', 'image-reuse',
    ]);
    for (const step of steps) {
      expect(step.querySelector('p')?.textContent?.length).toBeGreaterThan(30);
      expect(step.querySelector('figure figcaption')?.textContent?.length).toBeGreaterThan(10);
    }
    expect(page.document.querySelector('[data-testid="image-step-generate"]')?.textContent).toContain(copy.demo.generating);
    expect(page.document.querySelector('[data-testid="image-step-generate"]')?.textContent).toContain(copy.demo.completed);
    expect(page.document.querySelectorAll('[data-testid^="image-step-"] > .canvas')).toHaveLength(4);
    expect(page.document.querySelector('[data-testid="image-step-model"] [data-testid="image-models-screen"]')?.textContent).toContain(copy.demo.catalog);
    expect(page.document.querySelector('[data-testid="image-step-model"] [data-testid="image-model-options"]')?.textContent).toContain(copy.demo.searchChoices);
    expect(page.document.querySelector('[data-testid="image-step-open"] [data-testid="image-model-options"]')).toBeNull();
    expect(page.document.querySelector('[data-testid="image-step-generate"] [data-testid="image-workspace-canvas"] .columns')).not.toBeNull();
    expect(page.document.querySelector('[data-testid="image-step-reuse"] [data-testid="image-result-viewer"]')).not.toBeNull();
    expect(page.document.querySelector('[data-testid="image-step-reuse"]')?.textContent).toContain(copy.demo.reuseSettings);
    expect(page.document.querySelector('[data-testid="image-step-reuse"]')?.textContent).toContain(copy.demo.download);
    const exampleImages = [...page.document.querySelectorAll('[data-testid="image-step-generate"] .complete img, [data-testid="image-step-generate"] .asset img, [data-testid="image-step-reuse"] .complete img, [data-testid="image-step-reuse"] .asset img, [data-testid="image-step-reuse"] .viewer-image img')];
    expect(exampleImages).toHaveLength(5);
    expect(new Set(exampleImages.map(image => image.getAttribute('src'))).size).toBe(1);
    expect(page.document.querySelector('[data-testid="image-step-reuse"] .viewer-side p')?.textContent).toBe(copy.demo.promptSample);
    expect(page.document.querySelector('article')?.textContent).toContain(visibleGuideText({ text: copy.storage }));
    expect(page.document.querySelector('article')?.textContent).not.toContain('Naidan RPC');
    expect(page.document.querySelectorAll('figure button, figure input, figure a, figure audio')).toHaveLength(0);
    const related = page.document.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.relatedGuides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/models/llama-cpp-browser/`);
    expect(related?.textContent).toContain(copy.relatedTitle);
    expect(related?.textContent).toContain(copy.relatedDescription);
  });

  it.each([{ copy: audioEn, locale: 'en', common: commonEn }, { copy: audioJa, locale: 'ja', common: commonJa }] as const)('renders speech generation and explicit WAV saving in both languages', async ({ copy, locale, common }) => {
    const html = await renderToString(createSSRApp(AudioPage, { s: copy, locale, common }));
    using page = parsePage({ html });
    expect(page.document.querySelector('article h1')?.textContent).toBe(copy.title);
    const steps = [...page.document.querySelectorAll('section.media-step')];
    expect(steps.map(step => step.querySelector('h2')?.textContent)).toEqual([
      copy.steps.open.title, copy.steps.text.title, copy.steps.generate.title, copy.steps.save.title,
    ]);
    expect(steps.map(step => step.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'audio-open', 'audio-text', 'audio-generate', 'audio-save',
    ]);
    expect(page.document.querySelector('[data-testid="audio-step-generate"]')?.textContent).toContain(copy.demo.progress);
    expect(page.document.querySelector('[data-testid="audio-step-generate"]')?.textContent).toContain(copy.demo.generated);
    expect(page.document.querySelectorAll('[data-testid^="audio-step-"] > .canvas')).toHaveLength(4);
    expect(page.document.querySelector('[data-testid="audio-step-text"] .textarea')?.textContent).toContain(copy.demo.textSample);
    expect(page.document.querySelector('[data-testid="audio-step-text"] [data-testid="audio-model-options"]')?.textContent).toContain(copy.demo.filterModels);
    expect(page.document.querySelector('[data-testid="audio-step-text"] [data-testid="audio-language-options"]')?.textContent).toContain(copy.demo.modelDefault);
    expect(page.document.querySelector('[data-testid="audio-step-open"] [data-testid="audio-model-options"]')).toBeNull();
    expect(page.document.querySelector('[data-testid="audio-step-generate"] [data-testid="audio-result-card"]')).not.toBeNull();
    expect(page.document.querySelector('[data-testid="audio-step-save"]')?.textContent).toContain(copy.demo.saveWav);
    expect(page.document.querySelector('article')?.textContent).toContain(visibleGuideText({ text: copy.reading }));
    expect(page.document.querySelectorAll('figure button, figure input, figure a, figure audio')).toHaveLength(0);
    const related = page.document.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.relatedGuides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/models/llama-cpp-browser/`);
    expect(related?.textContent).toContain(copy.relatedTitle);
    expect(related?.textContent).toContain(copy.relatedDescription);
  });
});
