import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import type { Message } from '../models/types';
import { v7 as uuidv7 } from 'uuid';

describe('MessageItem Rendering', () => {
  const createMessage = (content: string, role: 'user' | 'assistant' = 'assistant'): Message => ({
    id: uuidv7(),
    role,
    content,
    timestamp: Date.now(),
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
    const contentArea = wrapper.find('.prose');
    expect(contentArea.text()).toBe('Actual response');
    expect(contentArea.text()).not.toContain('Internal thought');
  });
});
