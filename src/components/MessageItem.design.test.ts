import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import type { MessageNode } from '../models/types';
import { v7 as uuidv7 } from 'uuid';
import fs from 'fs';
import path from 'path';

describe('MessageItem Design (Dynamic Thinking Border)', () => {
  const createMessage = (content: string): MessageNode => ({
    id: uuidv7(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('applies thinking-border class when thinking is active', () => {
    const message = createMessage('<think>Deep thought...');
    const wrapper = mount(MessageItem, { props: { message } });
    
    const button = wrapper.find('[data-testid="toggle-thinking"]');
    expect(button.classes()).toContain('thinking-border');
  });

  it('contains the dynamic thinking border CSS requirements in the style block', () => {
    // We read the file directly to ensure the specific animation and design parameters are preserved
    const filePath = path.resolve(__dirname, 'MessageItem.vue');
    const content = fs.readFileSync(filePath, 'utf-8');

    // Check for key traits of the energetic thinking animation:
    // 1. Long dark period in keyframes (opacity 0 at 100% and 40%, but 1 at 35%)
    expect(content).toContain('35% {');
    expect(content).toContain('opacity: 1;');
    expect(content).toContain('40% {');
    expect(content).toContain('opacity: 0;');
    expect(content).toContain('100% {');

    // 2. Thinner border (1.2px)
    expect(content).toContain('padding: 1.2px;');

    // 3. Transparent border on the button itself to avoid square ghosting
    expect(content).toContain('border-color: transparent !important;');

    // 4. Energetic animation duration
    expect(content).toContain('animation: thinking-sweep 0.9s linear infinite;');
  });

  it('expands from button to full width area when clicked', async () => {
    const message = createMessage('<think>Thinking process content</think>Final response');
    const wrapper = mount(MessageItem, { props: { message } });
    
    const container = wrapper.find('[data-testid="toggle-thinking"]');
    
    // Initially it should be a small inline button
    expect(container.classes()).toContain('inline-flex');
    expect(container.classes()).not.toContain('w-full');
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);

    // Click to expand
    await container.trigger('click');

    // Now it should be a full width area
    expect(container.classes()).toContain('w-full');
    expect(container.classes()).not.toContain('inline-flex');
    expect(container.classes()).toContain('rounded-2xl'); // Should grow more rounded
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="thinking-content"]').text()).toBe('Thinking process content');

    // Click to collapse
    await container.trigger('click');
    expect(container.classes()).toContain('inline-flex');
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);
  });

  it('maintains the thinking border during expansion if thinking is active', async () => {
    const message = createMessage('<think>Ongoing thought...');
    const wrapper = mount(MessageItem, { props: { message } });
    
    const container = wrapper.find('[data-testid="toggle-thinking"]');
    expect(container.classes()).toContain('thinking-border');

    // Expand while thinking
    await container.trigger('click');
    expect(container.classes()).toContain('thinking-border');
    expect(container.classes()).toContain('w-full');
  });
});
