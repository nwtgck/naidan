import { readFileSync } from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';
import { describe, expect, it } from 'vitest';
import { cssForAssertions } from './css-assertions.test-support';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import HomeSpeechGenerationComparison from '../components/demos/HomeSpeechGenerationComparison.vue';
import { messages as en } from '../pages/index/messages/en';
import { messages as ja } from '../pages/index/messages/ja';
import { parsePage } from './site.test-support';

describe('home speech generation comparison', () => {
  it.each([{ messages: en }, { messages: ja }] as const)('shows where the same text becomes a WAV in both paths', async ({ messages }) => {
    using page = parsePage({ html: await renderToString(createSSRApp(HomeSpeechGenerationComparison, { messages })) });
    const local = page.document.querySelector('[data-testid="docs-local-speech-browser"]');
    const remote = page.document.querySelector('[data-testid="docs-remote-speech-browser"]');
    const server = page.document.querySelector('[data-testid="docs-remote-speech-server"]');

    expect(local?.querySelector('.workspace-brand')?.textContent).toContain(`Naidan${messages.audio_generation_ui}`);
    expect(local?.querySelector('.browser-tab')?.textContent).toContain('Naidan');
    expect(remote?.querySelector('.browser-tab')?.textContent).toContain(messages.ai_service);
    expect(remote?.querySelector('.service-header')?.textContent).toContain(messages.ai_service);
    const overhead = page.document.querySelector('.local-overhead');
    expect(overhead?.textContent).toContain(`Naidan${messages.no_text_sent_to_server}`);
    expect(overhead?.querySelector('.local-overhead-brand img')).not.toBeNull();
    expect(local?.querySelector('[data-testid="docs-local-speech-input"]')?.textContent).toContain(messages.qwen3_tts_1_7b_base);
    expect(local?.querySelector('[data-testid="docs-local-speech-input"]')?.textContent).toContain(messages.audio_language_choice);
    expect(local?.querySelector('.generate-action')?.textContent).toBe(messages.generate_audio);
    expect(local?.querySelectorAll('.generate-action svg')).toHaveLength(1);
    expect(local?.querySelector('.spoken-text .sr-only')?.textContent).toBe(messages.speech_text);
    expect(remote?.querySelector('.text-composer .sr-only')?.textContent).toBe(messages.speech_text);
    expect(remote?.querySelector('.sent-text')?.textContent).toBe(messages.speech_text);
    expect(local?.querySelector('.engine-core .received-text')?.textContent).toBe(messages.speech_text);
    expect(server?.querySelector('.received-text')?.textContent).toBe(messages.speech_text);
    expect(local?.querySelector('.local-travel .moving-text')?.textContent).toBe(messages.speech_text);
    expect(page.document.querySelector('.remote-travel .moving-text')?.textContent).toBe(messages.speech_text);
    expect(remote?.contains(server ?? null)).toBe(false);
    expect(server?.parentElement?.nextElementSibling).toBe(remote);

    for (const result of [local?.querySelector('[data-testid="docs-local-speech-wav"]'), remote?.querySelector('[data-testid="docs-remote-speech-wav"]')]) {
      expect(result?.textContent).toContain(messages.speech_text);
      expect(result?.textContent).toContain(messages.save_wav);
      expect(result?.querySelector('.wav-slot')).not.toBeNull();
      expect(result?.querySelector('.player')).not.toBeNull();
    }
    expect(local?.querySelector('.engine-core .wav-slot')).not.toBeNull();
    expect(server?.querySelector('.wav-slot')).not.toBeNull();
    for (const route of [page.document.querySelector('.local-travel'), page.document.querySelector('.remote-travel')]) {
      expect(route?.getAttribute('aria-hidden')).toBe('true');
      expect(route?.querySelector('.forming-wav')?.textContent).toContain('WAV');
      expect(route?.querySelector('.moving-wav')?.textContent).toContain('WAV');
      expect(route?.querySelector('.result-wav')?.textContent).toContain('WAV');
    }
    expect(page.document.querySelector('audio, video, button, input')).toBeNull();
  });

  it('keeps equal browser footprints and stops motion on the completed route', () => {
    const filename = new URL('../components/demos/HomeSpeechGenerationComparison.vue', import.meta.url).pathname;
    const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename });
    expect(errors).toEqual([]);
    const result = compileStyle({ filename, source: descriptor.styles[0]?.content ?? '', id: 'data-v-home-speech-comparison', scoped: true });
    expect(result.errors).toEqual([]);
    const css = cssForAssertions({ css: result.code });
    expect(css).toContain('grid-template-rows:100px 440px');
    expect(css).toContain('grid-template-rows:100px 584px');
    expect(css).toContain('opacity:.64');
    expect(css).toMatch(/@keyframes local-text-travel/);
    expect(css).toContain('--text-y:calc(100% -');
    expect(css).toMatch(/@keyframes remote-text-travel/);
    expect(css).toMatch(/@keyframes local-wav-travel/);
    expect(css).toMatch(/@keyframes remote-wav-travel/);
    expect(css).toContain('left:var(--wav-origin-x);top:var(--wav-origin-y)');
    expect(css).toContain('left:var(--wav-target-x);top:var(--wav-target-y)');
    expect(css).toMatch(/@keyframes local-wav-travel[^}]+left:var\(--wav-origin-x\)/);
    expect(css).toMatch(/@keyframes remote-wav-travel[^}]+left:var\(--wav-origin-x\)/);
    expect(css.match(/top:var\(--wav-target-y\);left:var\(--wav-target-x\);opacity:1;/g)).toHaveLength(2);
    expect(css).toMatch(/@keyframes received-text/);
    expect(css).toMatch(/@keyframes audio-input-disabled/);
    expect(css).toContain('opacity:.5');
    expect(css).toContain('opacity:.6');
    expect(css).toContain('animation:compare-audio-reveal-home-speech-comparison 8s ease-in-out -3.5s infinite both');
    expect(css).toContain('html:has(#docs-pause-motion:checked)');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toContain('animation:none!important;opacity:0;');
    expect(css).toContain('animation:none!important;opacity:1;');
  });
});
