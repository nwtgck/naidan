import { generateId } from '../utils/id';
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageThinking from './MessageThinking.vue';
import type { MessageNode } from '../models/types';

describe('MessageThinking Design', () => {
  const createMessageWithThinking = (content: string): MessageNode => ({
    id: generateId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('does not have uppercase header', () => {
    const message = createMessageWithThinking('<think>Testing</think>Hello');
    const wrapper = mount(MessageThinking, {
      props: { message }
    });

    const header = wrapper.find('[data-testid="thinking-header"]');
    expect(header.exists()).toBe(true);
    expect(header.classes()).not.toContain('uppercase');
  });

  it('shows "Show Thought Process" instead of all-caps header', () => {
    const message = createMessageWithThinking('<think>Done thinking</think>Hello');
    const wrapper = mount(MessageThinking, {
      props: { message }
    });

    expect(wrapper.text()).toContain('Show Thought Process');
    expect(wrapper.text()).not.toContain('SHOW THOUGHT PROCESS');
  });
});
