import { readFileSync } from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import { cssForAssertions } from './css-assertions.test-support';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import HomeChatGenerationComparison from '../components/demos/HomeChatGenerationComparison.vue';
import HomeTypingText from '../components/demos/HomeTypingText.vue';
import { messages as en } from '../pages/index/messages/en';
import { messages as ja } from '../pages/index/messages/ja';
import { docsHref } from '../navigation/routes';
import { createSiteFixture, parsePage, startSiteDev } from './site.test-support';

const scenes = [
  { scenario: 'chat', page: 'endpoint-type-llama-cpp-browser', guide: 'gguf_chat_guide_link' },
  { scenario: 'image', page: 'image-generation', guide: 'image_generation_guide_link' },
  { scenario: 'speech', page: 'audio-generation', guide: 'speech_generation_guide_link' },
] as const;

describe('home browser generation examples', () => {
  it.each([{ locale: 'en', messages: en }, { locale: 'ja', messages: ja }] as const)('shows three complete $locale browser-side flows before the model choices', async ({ locale, messages }) => {
    await using fixture = await createSiteFixture();
    await using dev = await startSiteDev({ root: fixture.root });
    using home = parsePage({ html: await (await dev.request({ url: docsHref({ locale, page: 'index' }) })).text() });

    const section = home.document.querySelector('[data-testid="docs-browser-generation"]');
    const examples = Array.from(section?.children ?? []).filter(child => child.matches('.browser-generation-example'));
    expect(examples).toHaveLength(3);
    expect(section?.nextElementSibling?.classList.contains('models-section')).toBe(true);

    for (const [index, expected] of scenes.entries()) {
      const example = examples[index];
      const heading = example?.querySelector('h2');
      const guideFooter = example?.querySelector('.local-mode > .generation-guide-footer');
      const guide = guideFooter?.querySelector(`[data-testid="docs-generation-guide-${expected.scenario}"]`);
      const localBrowser = example?.querySelector(`[data-testid="docs-local-${expected.scenario}-browser"]`);
      const remoteBrowser = example?.querySelector(`[data-testid="docs-remote-${expected.scenario}-browser"]`);
      const remoteServer = example?.querySelector(`[data-testid="docs-remote-${expected.scenario}-server"]`);
      const localOverhead = example?.querySelector('.local-overhead');
      expect(example?.classList.contains('generation-comparison-example')).toBe(true);
      expect(heading?.querySelector('a')).toBeNull();
      expect(guide?.getAttribute('href')).toBe(docsHref({ locale, page: expected.page }));
      expect(guide?.textContent).toBe(messages[expected.guide]);
      expect(guide?.getAttribute('aria-label')).toBe(messages[expected.guide]);
      expect(guide?.querySelector('svg')?.getAttribute('width')).toBe('20');
      expect(guideFooter?.previousElementSibling?.classList.contains('local-route')).toBe(true);
      expect(localBrowser?.contains(guide ?? null)).toBe(false);
      expect(localBrowser?.querySelector('.browser-tab')?.textContent).toContain('Naidan');
      expect(remoteBrowser?.querySelector('.browser-tab')?.textContent).toContain(messages.ai_service);
      expect(localBrowser?.querySelector('.browser-navigation .browser-address')).not.toBeNull();
      expect(remoteBrowser?.querySelector('.browser-navigation .browser-address')).not.toBeNull();
      expect(remoteServer?.textContent).toContain(messages.server);
      expect(localBrowser?.contains(remoteServer ?? null)).toBe(false);
      expect(remoteBrowser?.contains(remoteServer ?? null)).toBe(false);
      expect(localOverhead?.querySelector('img')?.getAttribute('src')).toBe(localBrowser?.querySelector('.browser-tab img')?.getAttribute('src'));
      expect(localOverhead?.querySelector('img')?.getAttribute('alt')).toBe('');
      expect(localOverhead?.querySelector('.brand-wordmark')?.textContent).toBe('Naidan');
      expect(localOverhead?.querySelector('.local-overhead-claim')?.textContent).toBe(expected.scenario === 'speech' ? messages.no_text_sent_to_server : messages.no_prompt_sent);
      expect(example?.querySelectorAll('.comparison-mode')).toHaveLength(2);
    }

    const chatExample = examples[0];
    expect(chatExample?.querySelector('[data-testid="docs-local-chat-answer"]')?.textContent).toBe(messages.chat_answer_chunks().join(''));
    expect(chatExample?.querySelector('[data-testid="docs-remote-chat-answer"]')?.textContent).toBe(messages.chat_answer_chunks().join(''));
    expect(chatExample?.querySelector('[data-testid="docs-local-chat-model"]')?.textContent).toContain(messages.gguf_model);
    expect(chatExample?.querySelector('[data-testid="docs-local-chat-question"]')?.textContent).toContain(messages.chat_question);
    expect(chatExample?.querySelector('[data-testid="docs-remote-chat-server"] .received-prompt')?.textContent).toBe(messages.chat_question);
    expect(chatExample?.querySelector('.generation-alt-route a')?.getAttribute('href')).toBe(docsHref({ locale, page: 'local-ai-servers' }));
    expect(chatExample?.querySelector('.generation-alt-route')?.textContent).toContain('Ollama');
    const imageExample = examples[1];
    const imageHeading = imageExample?.querySelector('#browser-generation-image-title');
    expect(imageHeading?.id).toBe('browser-generation-image-title');
    expect(imageHeading?.textContent).toBe(messages.cat_image_in_browser_heading);
    expect(imageHeading?.querySelector('a')).toBeNull();
    const imageGuide = imageExample?.querySelector('[data-testid="docs-generation-guide-image"]');
    expect(imageGuide?.getAttribute('href')).toBe(docsHref({ locale, page: 'image-generation' }));
    expect(imageGuide?.getAttribute('aria-label')).toBe(messages.image_generation_guide_link);
    expect(imageGuide?.querySelector('svg')).not.toBeNull();
    expect(imageHeading?.nextElementSibling?.tagName).toBe('P');
    expect(imageExample?.querySelector('.comparison-mode .mode-heading')).toBeNull();
    const localBrowser = imageExample?.querySelector('[data-testid="docs-local-image-browser"]');
    const remoteBrowser = imageExample?.querySelector('[data-testid="docs-remote-image-browser"]');
    const remoteServer = imageExample?.querySelector('[data-testid="docs-remote-image-server"]');
    const localScreen = localBrowser?.querySelector('.local-screen');
    const localHeader = localScreen?.querySelector('.workspace-brand');
    const localPrompt = localBrowser?.querySelector('[data-testid="docs-local-image-prompt"]');
    const remotePrompt = remoteBrowser?.querySelector('[data-testid="docs-remote-image-prompt"]');
    const localImage = localBrowser?.querySelector('img[data-testid="docs-local-image-result-art"]');
    const remoteImage = remoteBrowser?.querySelector('img[data-testid="docs-remote-image-result-art"]');
    expect(localBrowser?.querySelector('.browser-tab img')).not.toBeNull();
    expect(remoteBrowser?.querySelector('.browser-tab img')).toBeNull();
    expect(localBrowser?.querySelector('.toolbar-dots')).toBeNull();
    expect(localBrowser?.querySelector('.browser-tab svg')).not.toBeNull();
    expect(localPrompt?.textContent).toContain(messages.cat_image_prompt);
    expect(remotePrompt?.textContent).toContain(messages.cat_image_prompt);
    for (const prompt of [localPrompt?.querySelector('.typing-text'), remotePrompt?.querySelector('.prompt-composer .typing-text')]) {
      const characters = Array.from(prompt?.querySelectorAll<HTMLElement>('.typing-character') ?? []);
      expect(characters.map(character => character.textContent).join('')).toBe(messages.cat_image_prompt);
      const offsets = characters.map(character => Number.parseFloat(character.style.getPropertyValue('--typing-offset')));
      expect(offsets[0]).toBe(0);
      expect(offsets.at(-1)).toBe(.6);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    }
    expect(localPrompt?.querySelector('.typing-text')?.getAttribute('aria-hidden')).toBe('true');
    expect(remotePrompt?.querySelector('.prompt-composer')?.getAttribute('aria-hidden')).toBe('true');
    expect(remotePrompt?.querySelector('.send-action svg')).not.toBeNull();
    expect(remotePrompt?.querySelector('.prompt-bubble')?.textContent).toBe(messages.cat_image_prompt);
    expect(localHeader?.parentElement).toBe(localScreen);
    expect(localScreen?.querySelector('.local-workspace-left .image-editor')).toBe(localPrompt);
    expect(localScreen?.querySelector('.image-result')).not.toBeNull();
    expect(localPrompt?.querySelector('.workspace-brand')).toBeNull();
    expect(localHeader?.querySelector('.brand-name')?.textContent).toBe('Naidan');
    expect(localHeader?.textContent).toContain(messages.image_generation_ui);
    expect(remoteBrowser?.querySelector('.browser-tab')?.textContent).toBe(messages.ai_service);
    expect(remoteBrowser?.querySelector('.service-header')?.textContent).toContain(messages.ai_service);
    expect(localImage?.getAttribute('src')).toContain('flying-kitten');
    expect(remoteImage?.getAttribute('src')).toBe(localImage?.getAttribute('src'));
    expect(localImage?.getAttribute('alt')).toBe(messages.cat_image_alt);
    expect(remoteImage?.getAttribute('alt')).toBe(messages.cat_image_alt);
    expect(imageExample?.querySelector('.result-completed')).toBeNull();
    expect(localBrowser?.querySelector('[data-testid="docs-local-image-model"]')?.textContent).toContain(messages.image_model);
    expect(localBrowser?.querySelector('.engine-core .received-prompt')?.textContent).toBe(messages.cat_image_prompt);
    expect(localBrowser?.querySelector('.engine-core .forming-image img')?.getAttribute('src')).toBe(localImage?.getAttribute('src'));
    expect(localBrowser?.querySelector('[data-testid="docs-local-image-model"]')?.closest('.image-result')).toBeNull();
    expect(localBrowser?.contains(remoteServer ?? null)).toBe(false);
    expect(remoteBrowser?.contains(remoteServer ?? null)).toBe(false);
    expect(remoteServer?.closest('.remote-overhead')?.nextElementSibling).toBe(remoteBrowser);
    expect(remoteServer?.textContent).toContain(messages.server);
    expect(remoteServer?.querySelector('.received-prompt')?.textContent).toBe(messages.cat_image_prompt);
    expect(remoteServer?.querySelector('svg')).not.toBeNull();
    expect(remoteServer?.querySelector('.forming-image img')?.getAttribute('src')).toBe(remoteImage?.getAttribute('src'));
    expect(localBrowser?.querySelector('.local-travel .moving-prompt')?.textContent).toBe(messages.cat_image_prompt);
    expect(imageExample?.querySelector('.remote-travel .moving-prompt')?.textContent).toBe(messages.cat_image_prompt);
    expect(localBrowser?.querySelector('.local-travel .moving-image')?.getAttribute('src')).toBe(localImage?.getAttribute('src'));
    expect(imageExample?.querySelector('.remote-travel .moving-image')?.getAttribute('src')).toBe(remoteImage?.getAttribute('src'));
    expect(remoteBrowser?.querySelector('.remote-travel')).toBeNull();
    expect(imageExample?.querySelectorAll('.outside-route span')).toHaveLength(2);
    const speechExample = examples[2];
    expect(speechExample?.querySelector('[data-testid="docs-local-speech-input"] .select-field')?.textContent).toBe(messages.qwen3_tts_model_id);
    expect(speechExample?.querySelector('[data-testid="docs-local-speech-wav"] .result-meta strong')?.textContent).toBe(messages.qwen3_tts_model_id);
    expect(speechExample?.querySelector('[data-testid="docs-local-speech-model"] .engine-core strong')?.textContent).toBe(messages.qwen3_tts_1_7b_base);
    expect(speechExample?.querySelector('[data-testid="docs-local-speech-input"]')?.textContent).toContain(messages.audio_language_choice);
    expect(speechExample?.querySelector('[data-testid="docs-local-speech-wav"]')?.textContent).toContain(messages.save_wav);
    expect(speechExample?.querySelector('[data-testid="docs-remote-speech-wav"]')?.textContent).toContain(messages.save_wav);
    expect(speechExample?.querySelector('[data-testid="docs-remote-speech-server"] .received-text')?.textContent).toBe(messages.speech_text);
    expect(speechExample?.querySelector('.local-overhead')?.textContent).toContain(messages.no_text_sent_to_server);
    expect(section?.querySelector('audio, video, button, input')).toBeNull();
  });

  it.each([{ file: 'HomeChatGenerationComparison.vue', selector: '.chat-comparison' }, { file: 'HomeSpeechGenerationComparison.vue', selector: '.speech-comparison' }])('compiles completed pause and reduced-motion rules for $file', ({ file, selector }) => {
    const filename = new URL(`../components/demos/${file}`, import.meta.url).pathname;
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
    const result = compileStyle({ filename, source: descriptor.styles[0]?.content ?? '', id: 'data-v-home-comparison', scoped: true });
    expect(result.errors).toEqual([]);
    const css = cssForAssertions({ css: result.code });
    expect(css).toContain(`html:has(#docs-pause-motion:checked) ${selector}`);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toContain('animation:none!important;opacity:0;');
    expect(css).toContain('animation:none!important;opacity:1;');
  });

  it.each(['HomeChatGenerationComparison.vue', 'HomeImageGenerationComparison.vue', 'HomeSpeechGenerationComparison.vue'])('bounds both browser routes without changing their fixed heights in %s', file => {
    const filename = new URL(`../components/demos/${file}`, import.meta.url).pathname;
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
    const result = compileStyle({ filename, source: descriptor.styles[0]?.content ?? '', id: 'data-v-home-route-width', scoped: true });
    expect(result.errors).toEqual([]);
    const css = cssForAssertions({ css: result.code });
    const modeRule = css.match(/\.comparison-mode\[data-v-home-route-width\]\s*\{([^}]+)\}/)?.[1];
    expect(modeRule).toContain('justify-self:center');
    expect(modeRule).toContain('width:100%');
    expect(modeRule).toContain('max-width:560px');
  });

  it('keeps both image results on one timeline and preserves the completed comparison when motion stops', () => {
    const filename = new URL('../components/demos/HomeImageGenerationComparison.vue', import.meta.url).pathname;
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
    const result = compileStyle({ filename, source: descriptor.styles[0]?.content ?? '', id: 'data-v-home-image-comparison', scoped: true });
    expect(result.errors).toEqual([]);
    const css = cssForAssertions({ css: result.code });
    expect(css).toMatch(/\.result-stage[^}]+img[^}]+animation:compare-image-reveal-home-image-comparison 8s ease-in-out -3\.5s infinite both/);
    expect(css).toContain('grid-template-columns:repeat(2,minmax(0,1fr))');
    expect(css).toContain('grid-template-rows:100px 440px');
    expect(css).toContain('height:440px');
    expect(css).toContain('grid-template-rows:100px 584px');
    expect(css).toContain('height:584px');
    expect(css).toContain('width:160px;max-width:100%');
    expect(css).toMatch(/@keyframes local-prompt-travel/);
    expect(css).toMatch(/@keyframes remote-prompt-travel/);
    expect(css).toMatch(/@keyframes local-image-travel/);
    expect(css).toMatch(/@keyframes remote-image-travel/);
    expect(css).toMatch(/@keyframes forming-cat/);
    expect(css).toMatch(/@keyframes forming-grid/);
    expect(css).toMatch(/@keyframes generate-press/);
    expect(css).toMatch(/@keyframes send-press/);
    expect(css).toMatch(/@keyframes sent-prompt-presence/);
    expect(css).toMatch(/@keyframes model-path-presence/);
    expect(css).toContain('grid-row:1 / 3');
    expect(css).toMatch(/@keyframes received-prompt[^}]+24%,100%[^}]+opacity:0/);
    expect(css).toMatch(/@keyframes forming-cat[\s\S]*?58%,92%[^}]+opacity:\.14/);
    expect(css).toContain('left:var(--grid-x)');
    expect(css).toContain('left:var(--server-grid-x)');
    expect(css).toContain('html:has(#docs-pause-motion:checked)');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    const modelPath = css.match(/\.model-path\[data-v-home-image-comparison\]\s*\{([^}]+)\}/)?.[1];
    expect(modelPath).toContain('height:21px');
    expect(modelPath).not.toContain('bottom:0');
    expect(modelPath).toContain('animation:model-path-presence');
  });

  it('types prompt characters with a caret and shows the complete text when motion stops', () => {
    const filename = new URL('../components/demos/HomeTypingText.vue', import.meta.url).pathname;
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
    const result = compileStyle({ filename, source: descriptor.styles[0]?.content ?? '', id: 'data-v-home-typing-text', scoped: true });
    expect(result.errors).toEqual([]);
    const css = cssForAssertions({ css: result.code });
    expect(css).toContain('calc(-3.5s + var(--typing-offset))');
    expect(css).toMatch(/@keyframes typing-input-mask/);
    expect(css).toMatch(/@keyframes typing-character/);
    expect(css).toMatch(/@keyframes typing-caret-fast/);
    expect(css).toMatch(/@keyframes typing-caret-medium/);
    expect(css).toMatch(/@keyframes typing-caret-slow/);
    expect(css).toMatch(/@keyframes typing-caret-last/);
    expect(css).toMatch(/@keyframes typing-caret-only/);
    expect(css).toMatch(/@keyframes typing-caret-blink/);
    expect(css).toContain('html:has(#docs-pause-motion:checked) .typing-copy .typing-character[data-v-home-typing-text]');
    expect(css).toContain('visibility:hidden;');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it.each([{ text: 'a'.repeat(47), pace: 'caret-fast' }, { text: 'a'.repeat(23), pace: 'caret-medium' }, { text: 'あ'.repeat(15), pace: 'caret-slow' }, { text: 'x', pace: 'caret-slow' }])('chooses $pace timing for the prompt caret', async ({ text, pace }) => {
    using page = parsePage({ html: await renderToString(createSSRApp(HomeTypingText, { text })) });
    const copy = page.document.querySelector('.typing-copy');
    expect(copy?.classList.contains(pace)).toBe(true);
    expect(Array.from(copy?.querySelectorAll('.typing-character') ?? []).map(character => character.textContent).join('')).toBe(text);
  });

  it('streams every answer character when a translation has more than four source chunks', async () => {
    const chunks = ['Start ', 'with ', 'a walk, ', 'then read ', 'a book.'];
    using page = parsePage({ html: await renderToString(createSSRApp(HomeChatGenerationComparison, { messages: { ...en, chat_answer_chunks: () => [...chunks] } })) });
    const characters = [...chunks.join('')];
    for (const mode of ['local', 'remote']) {
      const scene = page.document.querySelector(`.${mode}-mode`);
      for (const selector of ['.generated-glyph', '.moving-answer', '.answer-glyph']) {
        const rendered = Array.from(scene?.querySelectorAll<HTMLElement>(selector) ?? []);
        expect(rendered.map(glyph => glyph.textContent)).toEqual(characters);
        const delays = rendered.map(glyph => Number.parseFloat(glyph.style.getPropertyValue('--glyph-offset')));
        expect(delays[0]).toBe(0);
        expect(delays.at(-1)).toBeCloseTo(2.8);
        expect(delays).toEqual([...delays].sort((a, b) => a - b));
      }
    }
  });
});
