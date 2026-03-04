import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageThinking from './MessageThinking.vue';
import type { MessageNode } from '../models/types';

describe('MessageThinking Stability and Layout', () => {
  const createMessage = (content: string, thinking?: string): MessageNode => ({
    id: 'test-id',
    role: 'assistant',
    content,
    thinking,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('maintains fixed height and stable padding during active thinking (collapsed-active)', () => {
    // Simulate active thinking state (unclosed <think> tag)
    const message = createMessage('<think>Initial thought...');
    const wrapper = mount(MessageThinking, { props: { message } });

    const outerContainer = wrapper.find('[data-testid="toggle-thinking"]');
    const contentContainer = wrapper.find('[data-testid="thinking-content"]');

    // 1. Fixed height for the outer box (h-32)
    expect(outerContainer.classes()).toContain('h-32');
    expect(outerContainer.classes()).not.toContain('max-h-32');

    // 2. Fixed height for the inner content (h-20)
    expect(contentContainer.classes()).toContain('h-20');
    expect(contentContainer.classes()).not.toContain('max-h-20');

    // 3. Stable padding and mask
    expect(contentContainer.classes()).toContain('pt-2');
    expect(contentContainer.classes()).toContain('mask-fade-top');
  });

  it('does not apply fixed heights when expanded', async () => {
    const message = createMessage('<think>Long thought...');
    const wrapper = mount(MessageThinking, { props: { message } });

    // Toggle to expanded
    await wrapper.find('[data-testid="toggle-thinking"]').trigger('click');

    const outerContainer = wrapper.find('[data-testid="toggle-thinking"]');
    const contentContainer = wrapper.find('[data-testid="thinking-content"]');

    // Expanded should use min-h or auto height, not fixed h-32/h-20
    expect(outerContainer.classes()).not.toContain('h-32');
    expect(outerContainer.classes()).toContain('min-h-[100px]');

    expect(contentContainer.classes()).not.toContain('h-20');
    expect(contentContainer.classes()).not.toContain('pt-2');
    expect(contentContainer.classes()).not.toContain('mask-fade-top');
  });

  it('hides content in collapsed-finished mode', () => {
    // Simulate finished thinking
    const message = createMessage('Final answer', 'Completed thought');
    const wrapper = mount(MessageThinking, { props: { message } });

    // In collapsed-finished, the content container should not exist (v-if)
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);

    const outerContainer = wrapper.find('[data-testid="toggle-thinking"]');
    expect(outerContainer.classes()).toContain('px-3');
    expect(outerContainer.classes()).toContain('py-1.5');
    expect(outerContainer.classes()).not.toContain('h-32');
  });
});
