import { generateId } from '../utils/id';
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import MessageThinking from './MessageThinking.vue';
import type { MessageNode } from '../models/types';
import fs from 'fs';
import path from 'path';

describe('MessageItem Design (Dynamic Thinking Border)', () => {
  const createMessage = (content: string): MessageNode => ({
    id: generateId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('applies thinking-gradient-border element when thinking is active', () => {
    const message = createMessage('<think>Deep thought...');
    const wrapper = mount(MessageItem, { props: { message } });

    const border = wrapper.find('.thinking-gradient-border');
    expect(border.exists()).toBe(true);
  });

  it('contains the dynamic thinking border CSS requirements in the style block of MessageThinking', () => {
    // We read the file directly to ensure the specific animation and design parameters are preserved
    const filePath = path.resolve(__dirname, 'MessageThinking.vue');
    const content = fs.readFileSync(filePath, 'utf-8');

    // Check for key traits of the energetic thinking animation:
    // 1. Long dark period in keyframes (opacity 0 at 100% and 40%, but 1 at 35%)
    expect(content).toContain('35% {');
    expect(content).toContain('opacity: 1;');
    expect(content).toContain('40% {');
    expect(content).toContain('opacity: 0;');
    expect(content).toContain('100% {');

    // 2. Thinner border (1.2px) in the new class
    expect(content).toContain('.thinking-gradient-border {');
    expect(content).toContain('padding: 1.2px;');

    // 3. Masking logic ( XOR / Exclude )
    expect(content).toContain('-webkit-mask-composite: xor;');
    expect(content).toContain('mask-composite: exclude;');

    // 4. Energetic animation duration
    expect(content).toContain('animation: thinking-sweep 0.9s linear infinite;');
  });

  it('is always full width but changes height based on expansion', async () => {
    const message = createMessage('<think>Thinking process content</think>Final response');
    const wrapper = mount(MessageThinking, { props: { message } });

    const container = wrapper.find('[data-testid="toggle-thinking"]');

    // Initially it should be full width (no longer inline-flex)
    expect(container.classes()).toContain('w-full');
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);

    // Click to expand
    await container.trigger('click');

    // Now it should be expanded (full height, content visible)
    expect(container.classes()).toContain('w-full');
    expect(container.classes()).toContain('rounded-2xl');
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="thinking-content"]').text()).toBe('Thinking process content');

    // Click to collapse
    await container.trigger('click');
    expect(container.classes()).toContain('w-full');
    expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);
  });

  it('shows a fixed-height streaming view when thinking is active but collapsed', async () => {
    // Message with unclosed <think> tag
    const message = createMessage('<think>Ongoing streaming thoughts...');
    const wrapper = mount(MessageThinking, { props: { message } });

    const container = wrapper.find('[data-testid="toggle-thinking"]');

    // Mode should be 'collapsed-active'
    expect(container.classes()).toContain('h-32');
    expect(container.classes()).toContain('overflow-hidden');

    // Content should be visible even when collapsed if active
    const content = wrapper.find('[data-testid="thinking-content"]');
    expect(content.exists()).toBe(true);
    expect(content.classes()).toContain('h-20');
    expect(content.classes()).toContain('mask-fade-top');
    expect(content.classes()).toContain('pt-2');
  });

  it('maintains the thinking border during expansion if thinking is active', async () => {
    const message = createMessage('<think>Ongoing thought...');
    const wrapper = mount(MessageItem, { props: { message } });

    const container = wrapper.find('[data-testid="toggle-thinking"]');
    expect(wrapper.find('.thinking-gradient-border').exists()).toBe(true);

    // Expand while thinking
    await container.trigger('click');
    expect(wrapper.find('.thinking-gradient-border').exists()).toBe(true);
    expect(container.classes()).toContain('w-full');
  });
});
