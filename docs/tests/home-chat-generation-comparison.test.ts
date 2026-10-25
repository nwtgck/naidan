import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import HomeChatGenerationComparison from '../components/demos/HomeChatGenerationComparison.vue';
import { messages as english } from '../pages/index/messages/en';
import { messages as japanese } from '../pages/index/messages/ja';
import { parsePage } from './site.test-support';

describe('homepage GGUF generation comparison', () => {
  it.each([{ locale: 'en', messages: english }, { locale: 'ja', messages: japanese }])('keeps the $locale input, generation and answer in their respective locations', async ({ messages }) => {
    const html = await renderToString(createSSRApp({ render: () => h(HomeChatGenerationComparison, { messages }) }));
    using page = parsePage({ html });
    const localBrowser = page.document.querySelector('[data-testid="docs-local-chat-browser"]');
    const remoteBrowser = page.document.querySelector('[data-testid="docs-remote-chat-browser"]');
    const localModel = page.document.querySelector('[data-testid="docs-local-chat-model"]');
    const remoteServer = page.document.querySelector('[data-testid="docs-remote-chat-server"]');
    const answer = messages.chat_answer_chunks().join('');

    expect(localBrowser?.textContent).toContain(messages.new_chat);
    expect(remoteBrowser?.textContent).toContain(messages.ai_service);
    expect(localBrowser?.querySelector('.chat-composer .sr-only')?.textContent).toBe(messages.chat_question);
    expect(localBrowser?.querySelector('.chat-composer .send-action .lucide-arrow-up')).not.toBeNull();
    expect(localBrowser?.querySelector('.chat-composer .lucide-send')).toBeNull();
    expect(remoteBrowser?.querySelector('.chat-composer .sr-only')?.textContent).toBe(messages.chat_question);
    expect(localModel?.querySelector('.received-prompt')?.textContent).toBe(messages.chat_question);
    expect(remoteServer?.querySelector('.received-prompt')?.textContent).toBe(messages.chat_question);
    expect([...localModel?.querySelectorAll('.node-answer .generated-glyph') ?? []].map(glyph => glyph.textContent).join('')).toBe(answer);
    expect([...remoteServer?.querySelectorAll('.server-answer .generated-glyph') ?? []].map(glyph => glyph.textContent).join('')).toBe(answer);
    expect(localBrowser?.querySelector('[data-testid="docs-local-chat-answer"]')?.textContent).toBe(answer);
    expect(remoteBrowser?.querySelector('[data-testid="docs-remote-chat-answer"]')?.textContent).toBe(answer);
    expect(localBrowser?.contains(localModel)).toBe(true);
    expect(remoteBrowser?.contains(remoteServer)).toBe(false);
    expect(page.document.querySelector('script, [data-docs-island]')).toBeNull();
  });

  it('streams every character from each processor into the same reply in order', async () => {
    const fragments = ['Start ', 'with ', 'a walk, ', 'then read ', 'a book.'];
    const characters = [...fragments.join('')];
    const messages = { ...english, chat_answer_chunks: () => [...fragments] };
    const html = await renderToString(createSSRApp({ render: () => h(HomeChatGenerationComparison, { messages }) }));
    using page = parsePage({ html });

    for (const mode of ['local', 'remote'] as const) {
      const scene = page.document.querySelector(`.${mode}-mode`);
      const generated = [...scene?.querySelectorAll<HTMLElement>('.generated-glyph') ?? []];
      const moving = [...scene?.querySelectorAll<HTMLElement>('.moving-answer') ?? []];
      const received = [...scene?.querySelectorAll<HTMLElement>('.answer-glyph') ?? []];
      for (const stage of [generated, moving, received]) {
        expect(stage.map(glyph => glyph.textContent)).toEqual(characters);
        const offsets = stage.map(glyph => Number.parseFloat(glyph.style.getPropertyValue('--glyph-offset')));
        expect(offsets[0]).toBe(0);
        expect(offsets.at(-1)).toBe(2.8);
        expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
        expect(offsets[1]! - offsets[0]!).toBeLessThan(0.28);
      }
      for (const index of characters.keys()) {
        expect(generated[index]?.parentElement).toBe(moving[index]?.parentElement);
      }
    }
  });

  it('preserves a longer stream and Unicode characters across arbitrary chunk boundaries', async () => {
    const fragments = ['A ', 'slow ', 'walk ', 'comes ', 'first. ', 'Read ', 'a book ', '🌿', ' and rest.'];
    const characters = [...fragments.join('')];
    const messages = { ...english, chat_answer_chunks: () => [...fragments] };
    const html = await renderToString(createSSRApp({ render: () => h(HomeChatGenerationComparison, { messages }) }));
    using page = parsePage({ html });

    for (const mode of ['local', 'remote'] as const) {
      const scene = page.document.querySelector(`.${mode}-mode`);
      const stages = ['.generated-glyph', '.moving-answer', '.answer-glyph'];
      for (const selector of stages) {
        const glyphs = [...scene?.querySelectorAll(selector) ?? []];
        expect(glyphs.map(glyph => glyph.textContent)).toEqual(characters);
        expect(glyphs.map(glyph => glyph.textContent).join('')).toBe(fragments.join(''));
      }
    }
  });
});
