import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import ImagePage from '../pages/image-generation/index.vue';
import AudioPage from '../pages/audio-generation/index.vue';
import { messages as imageEn } from '../pages/image-generation/messages/en';
import { messages as imageJa } from '../pages/image-generation/messages/ja';
import { messages as audioEn } from '../pages/audio-generation/messages/en';
import { messages as audioJa } from '../pages/audio-generation/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('media workflow guides', () => {
  it.each([{ copy: imageEn, locale: 'en', common: commonEn }, { copy: imageJa, locale: 'ja', common: commonJa }] as const)('renders every image step and its result as static HTML', async ({ copy, locale, common }) => {
    const html = await renderToString(createSSRApp(ImagePage, { s: copy, locale, common }));
    using page = parsePage({ html });
    expect(page.document.querySelector('article h1')?.textContent).toBe(copy.title);
    expect(page.document.querySelector('.app-entry-intro a')?.getAttribute('data-docs-app-entry-path')).toBe('/#/image-generation/');
    expect(page.document.querySelector('.app-entry-intro')?.textContent).toContain(locale === 'en' ? 'Hosted edition' : 'Hosted版');
    expect(page.document.querySelector('#image-model')?.parentElement?.textContent).toContain(locale === 'en' ? 'portable HTML edition' : 'ポータブルHTML版');
    const steps = [...page.document.querySelectorAll('section.media-step')];
    expect(steps.map(step => step.querySelector('h2')?.textContent)).toEqual([
      copy.open_the_image_workspace, copy.prepare_and_select_an_image_model, copy.enter_a_prompt_and_generate_an_image, copy.inspect_and_try_another_version,
    ]);
    expect(steps.map(step => step.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'image-open', 'image-model', 'image-generate', 'image-reuse',
    ]);
    for (const step of steps) {
      expect(step.querySelector('p')?.textContent?.length).toBeGreaterThan(30);
      expect(step.querySelector('figure figcaption')?.textContent?.length).toBeGreaterThan(10);
    }
    expect(page.document.querySelector('[data-testid="image-step-generate"]')?.textContent).toContain(copy.generating_image);
    expect(page.document.querySelector('[data-testid="image-step-generate"]')?.textContent).toContain(copy.completed);
    expect(page.document.querySelectorAll('[data-testid^="image-step-"] > .canvas')).toHaveLength(4);
    expect(page.document.querySelector('[data-testid="image-step-model"] [data-testid="image-models-screen"]')?.textContent).toContain(copy.model_catalog);
    expect(page.document.querySelector('[data-testid="image-step-model"] [data-testid="image-model-options"]')?.textContent).toContain(copy.search_choices);
    const modelPreparation = page.document.querySelector('[data-testid="image-step-model"]');
    expect(modelPreparation?.querySelector('.download-destination')?.textContent).toContain(copy.browser_storage);
    expect(modelPreparation?.querySelector('.import-methods')?.textContent).toContain(copy.save_in_browser);
    expect(modelPreparation?.querySelector('.import-methods')?.textContent).toContain(copy.link_folder);
    expect(modelPreparation?.querySelector('.import-methods')?.textContent).toContain(copy.use_temporarily);
    expect(page.document.querySelector('[data-testid="image-step-open"] [data-testid="image-model-options"]')).toBeNull();
    expect(page.document.querySelector('[data-testid="image-step-generate"] [data-testid="image-workspace-canvas"] .columns')).not.toBeNull();
    expect(page.document.querySelector('[data-testid="image-step-reuse"] [data-testid="image-result-viewer"]')).not.toBeNull();
    expect(page.document.querySelector('[data-testid="image-step-reuse"]')?.textContent).toContain(copy.reuse_saved_settings);
    expect(page.document.querySelector('[data-testid="image-step-reuse"]')?.textContent).toContain(copy.download_image);
    const exampleImages = [...page.document.querySelectorAll('[data-testid="image-step-generate"] .complete img, [data-testid="image-step-generate"] .asset img, [data-testid="image-step-reuse"] .complete img, [data-testid="image-step-reuse"] .asset img, [data-testid="image-step-reuse"] .viewer-image img')];
    expect(exampleImages).toHaveLength(5);
    expect(new Set(exampleImages.map(image => image.getAttribute('src'))).size).toBe(1);
    expect(exampleImages[0]?.getAttribute('src')).toContain('flying-kitten.webp');
    expect(page.document.querySelector('[data-testid="image-step-reuse"] .viewer-side p')?.textContent).toBe(copy.kitten_flying_through_blue_sky);
    expect(page.document.querySelector('#image-storage')?.parentElement?.textContent).toContain('OPFS');
    expect(page.document.querySelector('#image-storage')?.parentElement?.querySelector('.ui-label')).not.toBeNull();
    expect(page.document.querySelector('#image-storage')?.parentElement?.textContent).toContain(copy.temporary_models_and_saved_results);
    expect(page.document.querySelector('article')?.textContent).not.toContain('Naidan RPC');
    expect(page.document.querySelectorAll('figure button, figure input, figure a, figure audio')).toHaveLength(0);
    const related = page.document.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.related_guides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/endpoint-type-llama-cpp-browser/`);
    expect(related?.textContent).toContain(copy.run_a_gguf_model_in_your_browser);
    expect(related?.textContent).toContain(copy.start_a_chat_with_a_local_gguf_model);
  });

  it.each([{ copy: audioEn, locale: 'en', common: commonEn }, { copy: audioJa, locale: 'ja', common: commonJa }] as const)('renders speech generation and explicit WAV saving in both languages', async ({ copy, locale, common }) => {
    const html = await renderToString(createSSRApp(AudioPage, { s: copy, locale, common }));
    using page = parsePage({ html });
    expect(page.document.querySelector('article h1')?.textContent).toBe(copy.title);
    expect(page.document.querySelector('.app-entry-intro a')?.getAttribute('data-docs-app-entry-path')).toBe('/#/audio-generation');
    const steps = [...page.document.querySelectorAll('section.media-step')];
    expect(steps.map(step => step.querySelector('h2')?.textContent)).toEqual([
      copy.open_audio_generation_and_prepare_a_model, copy.enter_text_and_choose_its_language, copy.generate_and_follow_progress, copy.play_and_save_the_wav,
    ]);
    expect(steps.map(step => step.querySelector('[data-docs-animation]')?.getAttribute('data-docs-animation'))).toEqual([
      'audio-open', 'audio-text', 'audio-generate', 'audio-save',
    ]);
    expect(page.document.querySelector('[data-testid="audio-step-generate"]')?.textContent).toContain(copy.generating_audio);
    expect(page.document.querySelector('[data-testid="audio-step-generate"]')?.textContent).toContain(copy.generated_audio);
    expect(page.document.querySelectorAll('[data-testid^="audio-step-"] > .canvas')).toHaveLength(4);
    expect(page.document.querySelector('[data-testid="audio-step-text"] .textarea')?.textContent).toContain(copy.morning_light_sample);
    expect(page.document.querySelector('[data-testid="audio-step-text"] [data-testid="audio-model-options"]')?.textContent).toContain(copy.filter_models);
    expect(page.document.querySelector('[data-testid="audio-step-text"] .model-after')?.textContent).toBe(copy.qwen3_tts_model_id);
    expect(page.document.querySelector('[data-testid="audio-step-text"] .popup-model')?.textContent).toBe(copy.qwen3_tts_model_id);
    expect(page.document.querySelector('[data-testid="audio-step-save"] [data-testid="audio-result-model"]')?.textContent).toBe(copy.qwen3_tts_model_id);
    expect(page.document.querySelector('[data-testid="audio-step-text"] [data-testid="audio-language-options"]')?.textContent).toContain(copy.model_default);
    expect(page.document.querySelector('[data-testid="audio-step-open"] [data-testid="audio-model-options"]')).toBeNull();
    expect(page.document.querySelector('[data-testid="audio-step-generate"] [data-testid="audio-result-card"]')).not.toBeNull();
    expect(page.document.querySelector('[data-testid="audio-step-save"]')?.textContent).toContain(copy.save_wav);
    expect(page.document.querySelector('#audio-reading')?.parentElement?.textContent).toContain('Web Speech API');
    expect(page.document.querySelector('#audio-reading')?.parentElement?.querySelector('.ui-label')).not.toBeNull();
    expect(page.document.querySelectorAll('figure button, figure input, figure a, figure audio')).toHaveLength(0);
    const related = page.document.querySelector('[data-docs-related-guide]');
    expect(related?.getAttribute('aria-label')).toBe(common.related_guides);
    expect(related?.querySelector('a')?.getAttribute('href')).toBe(`/docs/${locale}/endpoint-type-llama-cpp-browser/`);
    expect(related?.textContent).toContain(copy.run_a_gguf_model_in_your_browser);
    expect(related?.textContent).toContain(copy.start_a_chat_with_a_local_gguf_model);
  });
});
