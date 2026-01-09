import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import type { MessageNode } from '../models/types';
import { v7 as uuidv7 } from 'uuid';

describe('MessageItem Rendering', () => {
  const createMessage = (content: string, role: 'user' | 'assistant' = 'assistant'): MessageNode => ({
    id: uuidv7(),
    role,
    content,
    timestamp: Date.now(),
    replies: { items: [] }
  });

  it('renders basic markdown correctly', () => {
    const message = createMessage('**bold text** and [link](https://example.com)');
    const wrapper = mount(MessageItem, { props: { message } });
    
    const html = wrapper.html();
    expect(html).toContain('<strong>bold text</strong>');
    expect(html).toContain('<a href="https://example.com"');
  });

  it('applies syntax highlighting to code blocks', () => {
    const message = createMessage('```python\nprint("hello")\n```');
    const wrapper = mount(MessageItem, { props: { message } });
    
    const html = wrapper.html();
    // highlight.js should wrap the code in spans with hljs classes
    expect(html).toContain('language-python');
    expect(html).toContain('hljs');
  });

  it('sanitizes dangerous HTML', () => {
    const message = createMessage('Dangerous <script>alert("xss")</script><img src=x onerror=alert(1)>');
    const wrapper = mount(MessageItem, { props: { message } });
    
    const html = wrapper.html();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onerror');
  });

  it('correctly separates and displays thinking blocks', async () => {
    const message = createMessage('<think>Internal thought</think>Actual response');
    const wrapper = mount(MessageItem, { props: { message } });
    
    // Check if thinking process button exists
    expect(wrapper.text()).toContain('Thought Process');
    
    // Check if the content part only shows the actual response
    const contentArea = wrapper.find('[data-testid="message-content"]');
    expect(contentArea.text()).toBe('Actual response');
    expect(contentArea.text()).not.toContain('Internal thought');
  });
});

describe('MessageItem Keyboard Shortcuts', () => {
  const createMessage = (content: string, role: 'user' | 'assistant' = 'user'): MessageNode => ({
    id: uuidv7(),
    role,
    content,
    timestamp: Date.now(),
    replies: { items: [] }
  });

  it('cancels editing on Escape key', async () => {
    const message = createMessage('Original content');
    const wrapper = mount(MessageItem, { props: { message } });
    
    // Enter edit mode
    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    expect(wrapper.find('[data-testid="edit-mode"]').exists()).toBe(true);
    
    const textarea = wrapper.find('[data-testid="edit-textarea"]');
    await textarea.setValue('Changed content');
    
    // Trigger Escape
    await textarea.trigger('keydown.esc');
    
    expect(wrapper.find('[data-testid="edit-mode"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="message-content"]').text()).toBe('Original content');
  });

  it('saves and branches on Ctrl+Enter', async () => {
    const message = createMessage('Original content');
    const wrapper = mount(MessageItem, { props: { message } });
    
    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    const textarea = wrapper.find('[data-testid="edit-textarea"]');
    await textarea.setValue('New branch content');
    
    // Trigger Ctrl+Enter
    await textarea.trigger('keydown.enter', { ctrlKey: true });
    
    // Should emit 'edit' event
    expect(wrapper.emitted('edit')).toBeTruthy();
    expect(wrapper.emitted('edit')?.[0]).toEqual([message.id, 'New branch content']);
    expect(wrapper.find('[data-testid="edit-mode"]').exists()).toBe(false);
  });

  it('saves and branches on Cmd+Enter', async () => {
    const message = createMessage('Original content');
    const wrapper = mount(MessageItem, { props: { message } });
    
    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    const textarea = wrapper.find('[data-testid="edit-textarea"]');
    await textarea.setValue('Meta content');
    
    // Trigger Cmd+Enter (metaKey)
    await textarea.trigger('keydown.enter', { metaKey: true });
    
    expect(wrapper.emitted('edit')).toBeTruthy();
    expect(wrapper.emitted('edit')?.[0]).toEqual([message.id, 'Meta content']);
  });
});
