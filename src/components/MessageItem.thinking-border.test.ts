import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import type { MessageNode } from '../models/types';

describe('MessageItem Thinking Border (New Implementation)', () => {
  const createMessage = (content: string, thinking?: string): MessageNode => ({
    id: 'test-id',
    role: 'assistant',
    content,
    thinking,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('renders the dedicated gradient border element when thinking', () => {
    // Simulate active thinking state (unclosed <think> tag)
    const message = createMessage('<think>Still thinking...');
    const wrapper = mount(MessageItem, { props: { message } });

    // Parent container (toggle button)
    const container = wrapper.find('[data-testid="toggle-thinking"]');
    expect(container.exists()).toBe(true);

    // Verification 1: The dedicated child element for the border must exist
    const borderElement = container.find('.thinking-gradient-border');
    expect(borderElement.exists()).toBe(true);

    // Verification 2: Must have border-radius: inherit to prevent square artifacts
    expect(borderElement.attributes('style')).toContain('border-radius: inherit');
  });

  it('does not apply conflicting border classes to the parent container when thinking', () => {
    const message = createMessage('<think>Still thinking...');
    const wrapper = mount(MessageItem, { props: { message } });
    const container = wrapper.find('[data-testid="toggle-thinking"]');

    // To prevent artifacts, the parent container should NOT have the standard 'border' class
    // or the old 'thinking-border' class when in active thinking mode.
    expect(container.classes()).not.toContain('border');
    expect(container.classes()).not.toContain('thinking-border');

    // Instead, it should explicitly allow overflow for the glow effect
    expect(container.classes()).toContain('overflow-visible');
  });

  it('removes the gradient border element when not thinking', () => {
    // Simulate completed thinking state
    const message = createMessage('Final response', 'Completed thought process');
    const wrapper = mount(MessageItem, { props: { message } });

    // The dedicated border element should NOT exist
    expect(wrapper.find('.thinking-gradient-border').exists()).toBe(false);

    // The parent SHOULD have the standard border
    const container = wrapper.find('[data-testid="toggle-thinking"]');
    expect(container.classes()).toContain('border');
  });
});
