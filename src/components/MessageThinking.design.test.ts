import { generateId } from '@/01-models/id';
import type { MessageId } from '@/01-models/ids';
import { describe, it, expect, beforeEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { mount } from '@vue/test-utils';
import MessageThinking from './MessageThinking.vue';
import type { MessageNode } from '@/01-models/types';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

describe('MessageThinking Design', () => {
  const createMessageWithThinking = (content: string): MessageNode => ({
    id: generateId<MessageId>(),
    role: 'assistant',
    replies: { items: [] },
    parts: [...(content !== undefined ? [{ id: 'text', type: 'text' as const, text: content, completeness: 'complete' as const }] : [])],
    createdAt: Date.now(),
    modelId: undefined,
    lmParameters: undefined,
    interruption: undefined,
  });

  it('isolates its internal stacking layers from surrounding UI', () => {
    const message = createMessageWithThinking('<think>Testing</think>Hello');
    const wrapper = mount(MessageThinking, {
      props: { message, isActive: message.parts.some(part => part.type === 'text' && part.text.includes('<think>') && !part.text.includes('</think>')) },
    });

    expect(wrapper.get('[data-testid="thinking-block"]').classes()).toContain('isolate');
  });

  it('does not have uppercase header', () => {
    const message = createMessageWithThinking('<think>Testing</think>Hello');
    const wrapper = mount(MessageThinking, {
      props: { message, isActive: message.parts.some(part => part.type === 'text' && part.text.includes('<think>') && !part.text.includes('</think>')) },
    });

    const header = wrapper.find('[data-testid="thinking-header"]');
    expect(header.exists()).toBe(true);
    expect(header.classes()).not.toContain('uppercase');
  });

  it('shows "Show Thought Process" instead of all-caps header', () => {
    const message = createMessageWithThinking('<think>Done thinking</think>Hello');
    const wrapper = mount(MessageThinking, {
      props: { message, isActive: message.parts.some(part => part.type === 'text' && part.text.includes('<think>') && !part.text.includes('</think>')) },
    });

    expect(wrapper.text()).toContain('Show Thought Process');
    expect(wrapper.text()).not.toContain('SHOW THOUGHT PROCESS');
  });
});
