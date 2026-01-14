import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import type { MessageNode } from '../models/types';
import { v7 as uuidv7 } from 'uuid';
import { Check } from 'lucide-vue-next';
import { nextTick } from 'vue';

describe('MessageItem Rendering', () => {
  const createMessage = (content: string, role: 'user' | 'assistant' = 'assistant'): MessageNode => ({
    id: uuidv7(),
    role,
    content,
    timestamp: Date.now(),
    replies: { items: [] },
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

  it('displays the assistant model name with correct casing', () => {
    const modelId = 'gemma3:1b-Assistant-Case';
    const message: MessageNode = {
      id: 'msg-1',
      role: 'assistant',
      content: 'Hello',
      modelId,
      timestamp: Date.now(),
      replies: { items: [] },
    };
    const wrapper = mount(MessageItem, { props: { message } });
    
    expect(wrapper.text()).toContain(modelId);
    expect(wrapper.text()).not.toContain(modelId.toUpperCase());
    // Ensure "You" is not shown
    expect(wrapper.text()).not.toContain('You');
  });

  it('displays "You" for user messages with correct styling', () => {
    const message = createMessage('Hello', 'user');
    const wrapper = mount(MessageItem, { props: { message } });
    
    const youSpan = wrapper.find('.uppercase.tracking-widest');
    expect(youSpan.exists()).toBe(true);
    expect(youSpan.text()).toBe('You');
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

  it('copies message content to clipboard', async () => {
    const message = createMessage('Copy me');
    const wrapper = mount(MessageItem, { props: { message } });
    
    // Mock clipboard
    const writeText = vi.fn().mockImplementation(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const copyButton = wrapper.find('[data-testid="copy-message-button"]');
    await copyButton.trigger('click');

    expect(writeText).toHaveBeenCalledWith('Copy me');
    
    // Wait for Vue to update the DOM
    await nextTick();
    
    // Icon should change to checkmark
    expect(wrapper.findComponent(Check).exists()).toBe(true);
  });

  it('toggles mermaid display modes', async () => {
    const message = createMessage('```mermaid\ngraph TD; A-->B;\n```');
    const wrapper = mount(MessageItem, { props: { message } });
    
    // Mode should be preview by default
    expect(wrapper.find('.mermaid-raw').attributes('style')).toContain('display: none');
    expect(wrapper.find('.mermaid').attributes('style')).not.toContain('display: none');

    // Manually set mode to 'code' via VM
    (wrapper.vm as unknown as { mermaidMode: string }).mermaidMode = 'code';
    await nextTick();
    await nextTick();

    expect(wrapper.find('.mermaid-raw').attributes('style')).not.toContain('display: none');
    expect(wrapper.find('.mermaid').attributes('style')).toContain('display: none');

    // Manually set mode to 'both'
    (wrapper.vm as unknown as { mermaidMode: string }).mermaidMode = 'both';
    await nextTick();
    await nextTick();

    const finalRaw = wrapper.find('.mermaid-raw').attributes('style') || '';
    const finalDiagram = wrapper.find('.mermaid').attributes('style') || '';
    
    expect(finalRaw).not.toContain('display: none');
    expect(finalDiagram).not.toContain('display: none');
  });

  describe('Mermaid UI Design Consistency', () => {
    it('has the correct layout structure and classes for positioning', async () => {
      const message = createMessage('```mermaid\ngraph TD; A-->B;\n```');
      const wrapper = mount(MessageItem, { props: { message } });
      await nextTick();
      await nextTick();
      
      const html = wrapper.html();
      expect(html).toContain('mermaid-block relative group/mermaid');
      expect(html).toContain('mermaid-ui-overlay');
      expect(html).toContain('mermaid-tabs');
    });

    it('contains Mermaid tabs with correct labels', async () => {
      const message = createMessage('```mermaid\ngraph TD; A-->B;\n```');
      const wrapper = mount(MessageItem, { props: { message } });
      await nextTick();
      await nextTick();
      
      const tabs = wrapper.findAll('.mermaid-tab');
      expect(tabs.length).toBe(3);
      expect(tabs[0]!.text()).toContain('Preview');
      expect(tabs[1]!.text()).toContain('Code');
      expect(tabs[2]!.text()).toContain('Both');
    });

    it('handles Mermaid copy button click', async () => {
      vi.useFakeTimers();
      const message = createMessage('```mermaid\ngraph TD; A-->B;\n```');
      const wrapper = mount(MessageItem, {
        props: { message },
        attachTo: document.body,
      });
      await nextTick();
      await nextTick();

      const writeText = vi.fn().mockImplementation(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      const copyBtn = wrapper.find('.mermaid-copy-btn');
      expect(copyBtn.exists()).toBe(true);

      await copyBtn.trigger('click');
      await nextTick();

      expect(writeText).toHaveBeenCalledWith('graph TD; A-->B;');
      expect(copyBtn.text()).toContain('Copied');

      // Check revert
      vi.advanceTimersByTime(2100);
      await nextTick();
      expect(copyBtn.text()).toContain('Copy');

      vi.useRealTimers();
      wrapper.unmount();
    });

    it('has the correct design classes for Mermaid copy button', async () => {
      const message = createMessage('```mermaid\ngraph TD; A-->B;\n```');
      const wrapper = mount(MessageItem, { props: { message } });
      await nextTick();
      await nextTick();

      const copyBtn = wrapper.find('.mermaid-copy-btn');
      expect(copyBtn.exists()).toBe(true);
      
      const cls = copyBtn.classes();
      expect(cls).toContain('bg-white/90');
      expect(cls).toContain('dark:bg-gray-800/90');
      expect(cls).toContain('backdrop-blur-sm');
      expect(cls).toContain('rounded-md');
      expect(cls).toContain('shadow-sm');
      expect(cls).toContain('opacity-0'); // Hidden by default
      expect(cls).toContain('group-hover/mermaid:opacity-100'); // Show on hover
      expect(copyBtn.attributes('title')).toBe('Copy Mermaid code');
    });
  });
  describe('Code Block Toolbar', () => {
    it('renders the code block toolbar with language label and copy button', () => {
      const message = createMessage('```javascript\nconst a = 1;\n```');
      const wrapper = mount(MessageItem, { props: { message } });
      const html = wrapper.html();

      // Check for wrapper structure
      expect(html).toContain('code-block-wrapper');
      expect(html).toContain('group/code');
      
      // Check for header toolbar
      expect(html).toContain('code-copy-btn');
      expect(html).toContain('javascript'); // Language label
      expect(html).toContain('Copy'); // Button text
    });

    it('ensures correct styling classes are applied to avoid white frame', () => {
      const message = createMessage('```python\nprint("test")\n```');
      const wrapper = mount(MessageItem, { props: { message } });
      const html = wrapper.html();

      // Check for key classes that prevent white frame issue
      expect(html).toContain('!bg-transparent');
      expect(html).toContain('!m-0');
      expect(html).toContain('!p-4');
      expect(html).toContain('!border-none');
      // Ensure wrapper has the dark background
      expect(html).toContain('bg-[#0d1117]');
    });

    it('handles copy button click and visual feedback', async () => {
      // Use fake timers BEFORE the action
      vi.useFakeTimers();
      
      const message = createMessage('```typescript\nconst x: number = 42;\n```');
      const wrapper = mount(MessageItem, {
        props: { message },
        attachTo: document.body,
      });

      // Mock clipboard
      const writeText = vi.fn().mockImplementation(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      const copyBtn = wrapper.find('.code-copy-btn');
      const btnEl = copyBtn.element;

      // Trigger click
      await copyBtn.trigger('click');
      
      // The click handler is async, so we need to wait for the promise to resolve
      // but since it's an event listener, we just need a tick.
      await nextTick();

      // Verify clipboard call
      expect(writeText).toHaveBeenCalledWith('const x: number = 42;');
      expect(btnEl.innerHTML).toContain('Copied');
      
      // Advance timers and wait for Vue to update the DOM
      vi.advanceTimersByTime(2100);
      await nextTick();
      
      expect(btnEl.innerHTML).toContain('Copy');
      
      vi.useRealTimers();
      wrapper.unmount();
    });

    it('has the correct design classes for standard code block copy button', () => {
      const message = createMessage('```js\nconsole.log(1);\n```');
      const wrapper = mount(MessageItem, { props: { message } });
      const copyBtn = wrapper.find('.code-copy-btn');
      
      expect(copyBtn.classes()).toContain('flex');
      expect(copyBtn.classes()).toContain('items-center');
      expect(copyBtn.classes()).toContain('gap-1.5');
      expect(copyBtn.classes()).toContain('hover:text-white');
      expect(copyBtn.classes()).toContain('transition-colors');
      expect(copyBtn.attributes('title')).toBe('Copy code');
    });
  });
});

describe('MessageItem Keyboard Shortcuts', () => {
  const createMessage = (content: string, role: 'user' | 'assistant' = 'user'): MessageNode => ({
    id: uuidv7(),
    role,
    content,
    timestamp: Date.now(),
    replies: { items: [] },
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

describe('MessageItem Attachment Rendering', () => {
  const createMessageWithAttachments = (attachments: any[]): MessageNode => ({
    id: uuidv7(),
    role: 'user',
    content: 'Message with images',
    timestamp: Date.now(),
    attachments,
    replies: { items: [] },
  });

  beforeEach(() => {
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('mock-url'),
      revokeObjectURL: vi.fn(),
    });
  });

  it('renders memory attachments using local blobs', async () => {
    const message = createMessageWithAttachments([{
      id: 'att-mem',
      status: 'memory',
      blob: new Blob([''], { type: 'image/png' }),
      originalName: 'mem.png',
      mimeType: 'image/png',
      size: 10,
      uploadedAt: Date.now()
    }]);

    const wrapper = mount(MessageItem, { props: { message } });
    await nextTick();
    await nextTick();

    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('src')).toBe('mock-url');
  });

  it('renders persisted attachments by fetching from storage', async () => {
    // Mock storageService
    const { storageService } = await import('../services/storage');
    vi.spyOn(storageService, 'getFile').mockResolvedValue(new Blob([''], { type: 'image/png' }));

    const message = createMessageWithAttachments([{
      id: 'att-persisted',
      status: 'persisted',
      originalName: 'persisted.png',
      mimeType: 'image/png',
      size: 20,
      uploadedAt: Date.now()
    }]);

    const wrapper = mount(MessageItem, { props: { message } });
    await nextTick();
    await nextTick();
    await nextTick(); // Wait for loadAttachments async

    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(storageService.getFile).toHaveBeenCalledWith('att-persisted', 'persisted.png');
  });

  it('renders a fallback for missing attachments', async () => {
    const message = createMessageWithAttachments([{
      id: 'att-missing',
      status: 'missing',
      originalName: 'missing.png',
      mimeType: 'image/png',
      size: 30,
      uploadedAt: Date.now()
    }]);

    const wrapper = mount(MessageItem, { props: { message } });
    await nextTick();

    expect(wrapper.text()).toContain('Image missing');
    expect(wrapper.text()).toContain('missing.png');
    expect(wrapper.text()).toContain('30.0 B');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('renders a download button for valid attachments', async () => {
    const message = createMessageWithAttachments([{
      id: 'att-mem',
      status: 'memory',
      blob: new Blob([''], { type: 'image/png' }),
      originalName: 'mem.png',
      mimeType: 'image/png',
      size: 10,
      uploadedAt: Date.now()
    }]);

    const wrapper = mount(MessageItem, { props: { message } });
    await nextTick();
    await nextTick();

    const downloadBtn = wrapper.find('[data-testid="download-attachment"]');
    expect(downloadBtn.exists()).toBe(true);
    expect(downloadBtn.attributes('href')).toBe('mock-url');
    expect(downloadBtn.attributes('download')).toBe('mem.png');
  });
});
