import { describe, expect, it } from 'vitest';
import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';
import HomeChatResponseDemo from '../components/HomeChatResponseDemo.vue';
import NaidanChatInput from '../components/demos/NaidanChatInput.vue';
import { messages as homeEn } from '../pages/index/messages/en';
import { messages as homeJa } from '../pages/index/messages/ja';
import { messages as commonEn } from '../messages/common/en';
import { messages as commonJa } from '../messages/common/ja';
import { parsePage } from './site.test-support';

describe('homepage chat replica', () => {
  it.each([
    { locale: 'en', home: homeEn, common: commonEn },
    { locale: 'ja', home: homeJa, common: commonJa },
  ])('renders the complete $locale conversation as static localized HTML', async ({ home, common }) => {
    const html = await renderToString(createSSRApp({ render: () => h(HomeChatResponseDemo, { messages: home, common }) }));
    using page = parsePage({ html });
    const scene = page.document.querySelector('[data-testid="docs-home-chat-scene"]');
    expect(scene).not.toBeNull();
    expect(scene?.querySelector('[data-testid="docs-home-prompt"]')?.textContent).toBe(home.plan_for_tomorrow_prompt);
    expect(scene?.querySelector('[data-testid="docs-home-response-intro"]')?.textContent).toBe(home.plan_answer_intro);
    expect(Array.from(scene?.querySelectorAll('[data-testid="docs-home-response-item"]') ?? [], item => item.textContent)).toEqual(home.plan_answer_items());
    expect(home.plan_intro_chunks().join('')).toBe(home.plan_answer_intro);
    expect(home.plan_item_chunks().map(chunks => chunks.join(''))).toEqual(home.plan_answer_items());
    const chunks = Array.from(scene?.querySelectorAll('[data-testid="docs-home-response-chunk"]') ?? []);
    expect(chunks.map(chunk => Number(chunk.getAttribute('data-chunk-index')))).toEqual(Array.from({ length: chunks.length }, (_, index) => index));
    expect(chunks.length).toBeGreaterThan(1 + home.plan_answer_items().length);
    expect(chunks.every(chunk => Boolean(chunk.textContent?.trim()))).toBe(true);
    expect(scene?.querySelectorAll('.demo-message')).toHaveLength(2);
    expect(scene?.textContent).toContain(home.type_a_message);
    expect(scene?.textContent).toContain('Gemma');
    expect(scene?.textContent).not.toContain('notes.txt');
    const input = scene?.querySelector('[data-testid="docs-chat-input"]');
    expect(input?.querySelectorAll('button, input, textarea, [tabindex]')).toHaveLength(0);
    expect(Array.from(input?.querySelectorAll('[data-testid]') ?? [], element => element.getAttribute('data-testid')).filter(testId => ['docs-chat-input-attach', 'docs-chat-input-tools', 'docs-chat-input-editor', 'docs-chat-input-model', 'docs-chat-input-send'].includes(testId ?? ''))).toEqual(['docs-chat-input-attach', 'docs-chat-input-tools', 'docs-chat-input-editor', 'docs-chat-input-model', 'docs-chat-input-send']);
    expect(input?.querySelector('[data-testid="docs-chat-input-source"]')).toBeNull();
    expect(page.document.querySelector('.replica-model-source')).toBeNull();
    expect(input?.querySelector('[data-testid="docs-chat-input-tools"]')?.getAttribute('title')).toBe(common.chrome_tools);
    expect(input?.querySelector('.demo-send-ready svg')?.classList.contains('lucide-arrow-up')).toBe(true);
    expect(input?.querySelector('.demo-send-stop svg')?.classList.contains('lucide-square')).toBe(true);
    expect(page.document.querySelector('script, [data-docs-island]')).toBeNull();
  });

  it.each([
    { common: commonEn, effort: 'High' },
    { common: commonJa, effort: '高' },
  ])('keeps model inheritance and reasoning readable in the static generating view', async ({ common, effort }) => {
    const html = await renderToString(createSSRApp({ render: () => h(NaidanChatInput, { messages: common, model: 'Qwen', source: common.chrome_inherit, reasoning: effort, status: 'generating' }) }));
    using page = parsePage({ html });
    expect(page.document.querySelector('[data-testid="docs-chat-input-source"]')?.textContent).toBe(common.chrome_inherit);
    expect(page.document.querySelector('[data-testid="docs-chat-input-reasoning"]')?.textContent).toBe(effort);
    expect(page.document.querySelector('[data-testid="docs-chat-input-reasoning"]')?.getAttribute('title')).toBe(common.chrome_reasoning);
    expect(page.document.querySelector('[data-testid="docs-chat-input-send"]')?.getAttribute('title')).toBe(common.chrome_stop);
    expect(page.document.querySelector('button, input, textarea, script')).toBeNull();
  });
});
