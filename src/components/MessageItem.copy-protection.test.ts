import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import type { MessageNode } from '../models/types';

describe('MessageItem Copy Protection', () => {
  const createMessage = (content: string, thinking?: string): MessageNode => ({
    id: 'test-id',
    role: 'assistant',
    content,
    thinking,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  const originalGetSelection = window.getSelection;

  beforeEach(() => {
    // Mock window.getSelection
    window.getSelection = vi.fn().mockReturnValue({
      toString: () => '',
    });
  });

  afterEach(() => {
    window.getSelection = originalGetSelection;
  });

  it('toggles thinking block when no text is selected', async () => {
    const message = createMessage('Final response', 'Thought process');
    const wrapper = mount(MessageItem, { props: { message } });
    
    const toggle = wrapper.find('[data-testid="toggle-thinking"]');
    
    // Initial state: showThinking is false (default)
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);
    
    await toggle.trigger('click');
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(true);
    
    await toggle.trigger('click');
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);
  });

  it('does NOT toggle thinking block when text is selected (prevents accidental closing on copy)', async () => {
    const message = createMessage('Final response', 'Thought process');
    const wrapper = mount(MessageItem, { props: { message } });
    
    const toggle = wrapper.find('[data-testid="toggle-thinking"]');
    
    // Expand first
    await toggle.trigger('click');
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(true);
    
    // Simulate text selection
    window.getSelection = vi.fn().mockReturnValue({
      toString: () => 'some selected text',
    });
    
    // Try to click (e.g. at the end of a drag-to-select)
    await toggle.trigger('click');
    
    // Verification: It should STILL BE OPEN
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(true);
  });
});
