import { generateId } from '../utils/id';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import type { MessageNode } from '../models/types';
import { Check } from 'lucide-vue-next';
import { nextTick } from 'vue';

describe('MessageItem Rendering', () => {
  const createMessage = (content: string, role: 'user' | 'assistant' = 'assistant'): MessageNode => ({
    id: generateId(),
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

  it('detects active thinking state (isThinkingNow)', () => {
    const message = createMessage('<think>Ongoing thought...');
    const wrapper = mount(MessageItem, { props: { message } });

    // Should show "Thinking..." instead of "Show Thought Process"
    expect(wrapper.text()).toContain('Thinking...');
    expect(wrapper.find('.thinking-gradient-border').exists()).toBe(true);
  });

  it('handles multiple thinking blocks and case-insensitivity', async () => {
    const message = createMessage('<THINK>Thought 1</THINK>Response 1<think>Thought 2</think>Response 2');
    const wrapper = mount(MessageItem, { props: { message } });

    // displayContent should be cleaned
    const contentArea = wrapper.find('[data-testid="message-content"]');
    expect(contentArea.text()).toContain('Response 1');
    expect(contentArea.text()).toContain('Response 2');
    expect(contentArea.text()).not.toContain('Thought 1');
    expect(contentArea.text()).not.toContain('Thought 2');

    // Toggle it to see the content
    const toggle = wrapper.find('[data-testid="toggle-thinking"]');
    await toggle.trigger('click');

    const thinkingArea = wrapper.find('[data-testid="thinking-content"]');
    expect(thinkingArea.text()).toContain('Thought 1');
    expect(thinkingArea.text()).toContain('Thought 2');
    expect(thinkingArea.text()).toContain('---');
  });

  it('hides loading indicator when thinking is active', () => {
    // Content is empty, but <think> is present
    const message = createMessage('<think>Thinking only');
    const wrapper = mount(MessageItem, { props: { message } });

    expect(wrapper.find('[data-testid="loading-indicator"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="thinking-block"]').exists()).toBe(true);
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
    id: generateId(),
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

  it('clears all content when Clear button is clicked', async () => {
    const message = createMessage('Original content');
    const wrapper = mount(MessageItem, { props: { message } });

    // Enter edit mode
    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    const textarea = wrapper.find('[data-testid="edit-textarea"]');
    await textarea.setValue('Some text to clear');

    // Clear button should exist since textarea has content
    const clearBtn = wrapper.find('[data-testid="clear-edit-content"]');
    expect(clearBtn.exists()).toBe(true);

    await clearBtn.trigger('click');
    await nextTick();

    expect((textarea.element as HTMLTextAreaElement).value).toBe('');
    // Clear button should be hidden when content is empty
    expect(wrapper.find('[data-testid="clear-edit-content"]').exists()).toBe(false);
  });
});

describe('MessageItem Attachment Rendering', () => {
  const createMessageWithAttachments = (attachments: any[]): MessageNode => ({
    id: generateId(),
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
      binaryObjectId: 'binary-id-123',
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
    expect(storageService.getFile).toHaveBeenCalledWith('binary-id-123');
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

describe('MessageItem States', () => {
  const createAssistantMessage = (content: string, error?: string): MessageNode => ({
    id: generateId(),
    role: 'assistant',
    content,
    error,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('displays loading indicator when waiting for response', () => {
    const message = createAssistantMessage('');
    const wrapper = mount(MessageItem, { props: { message } });

    expect(wrapper.find('[data-testid="loading-indicator"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Waiting for response...');
    expect(wrapper.find('[data-testid="message-content"]').exists()).toBe(false);
  });

  it('does NOT display loading indicator when content exists', () => {
    const message = createAssistantMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });

    expect(wrapper.find('[data-testid="loading-indicator"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="message-content"]').exists()).toBe(true);
  });

  it('displays error message when generation failed', () => {
    const message = createAssistantMessage('', 'Network Error');
    const wrapper = mount(MessageItem, { props: { message } });

    const errorEl = wrapper.find('[data-testid="error-message"]');
    expect(errorEl.exists()).toBe(true);
    expect(errorEl.text()).toContain('Generation Failed');
    expect(errorEl.text()).toContain('Network Error');
    expect(wrapper.find('[data-testid="loading-indicator"]').exists()).toBe(false);
  });

  it('displays partial content AND error message', () => {
    const message = createAssistantMessage('Partial content', 'Stream Error');
    const wrapper = mount(MessageItem, { props: { message } });

    expect(wrapper.find('[data-testid="message-content"]').text()).toBe('Partial content');

    const errorEl = wrapper.find('[data-testid="error-message"]');
    expect(errorEl.exists()).toBe(true);
    expect(errorEl.text()).toContain('Stream Error');
  });

  it('emits regenerate event when button clicked', async () => {
    const message = createAssistantMessage('', 'Error');
    const wrapper = mount(MessageItem, { props: { message } });

    await wrapper.find('[data-testid="retry-button"]').trigger('click');

    expect(wrapper.emitted('regenerate')).toBeTruthy();
    expect(wrapper.emitted('regenerate')?.[0]).toEqual([message.id]);
  });

  it('emits regenerate event when action bar button clicked', async () => {
    const message = createAssistantMessage('Existing content');
    const wrapper = mount(MessageItem, { props: { message } });

    await wrapper.find('[data-testid="regenerate-button"]').trigger('click');

    expect(wrapper.emitted('regenerate')).toBeTruthy();
    expect(wrapper.emitted('regenerate')?.[0]).toEqual([message.id]);
  });
});

describe('MessageItem Edit Labels', () => {
  const createMessage = (role: 'user' | 'assistant'): MessageNode => ({
    id: generateId(),
    role,
    content: 'Some content',
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('shows "Send & Branch" when editing a user message', async () => {
    const message = createMessage('user');
    const wrapper = mount(MessageItem, { props: { message } });

    // Enter edit mode
    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');

    const saveBtn = wrapper.find('[data-testid="save-edit"]');
    expect(saveBtn.text()).toContain('Send & Branch');
  });

  it('shows "Update & Branch" when editing an assistant message', async () => {
    const message = createMessage('assistant');
    const wrapper = mount(MessageItem, { props: { message } });

    // Enter edit mode
    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');

    const saveBtn = wrapper.find('[data-testid="save-edit"]');
    expect(saveBtn.text()).toContain('Update & Branch');
  });

  it('allows "Send & Branch" even if content is NOT edited', async () => {
    const message = createMessage('user');
    const wrapper = mount(MessageItem, { props: { message } });

    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');

    // Trigger Save without changing setValue
    await wrapper.find('[data-testid="save-edit"]').trigger('click');

    expect(wrapper.emitted('edit')).toBeTruthy();
    expect(wrapper.emitted('edit')?.[0]).toEqual([message.id, 'Some content']);
  });

  it('shows "Resend" button for user messages and emits edit event', async () => {
    const message = createMessage('user');
    const wrapper = mount(MessageItem, { props: { message } });

    const resendBtn = wrapper.find('[data-testid="resend-button"]');
    expect(resendBtn.exists()).toBe(true);
    expect(resendBtn.attributes('title')).toBe('Resend message');

    await resendBtn.trigger('click');

    expect(wrapper.emitted('edit')).toBeTruthy();
    expect(wrapper.emitted('edit')?.[0]).toEqual([message.id, 'Some content']);
  });

  it('does NOT show "Resend" button for assistant messages', () => {
    const message = createMessage('assistant');
    const wrapper = mount(MessageItem, { props: { message } });

    expect(wrapper.find('[data-testid="resend-button"]').exists()).toBe(false);
  });
});

describe('MessageItem Action Visibility', () => {
  const createMessage = (role: 'user' | 'assistant'): MessageNode => ({
    id: generateId(),
    role,
    content: 'Some content',
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('ensures message actions are always visible (no hover-only opacity classes)', () => {
    const message = createMessage('assistant');
    const wrapper = mount(MessageItem, { props: { message } });

    // Find the container of message actions. It's the sibling of version paging or an empty div.
    // In our template it's: <div class="flex items-center gap-1">
    // We can find it by looking for one of the buttons inside it.
    const copyButton = wrapper.find('[data-testid="copy-message-button"]');
    const container = copyButton.element.parentElement;

    expect(container?.className).not.toContain('opacity-0');
    expect(container?.className).not.toContain('group-hover:opacity-100');
  });
});

describe('MessageItem Touch Support', () => {
  it('applies touch-visible class to attachment download buttons', async () => {
    const message: MessageNode = {
      id: generateId(),
      role: 'user',
      content: 'Message with images',
      timestamp: Date.now(),
      attachments: [{
        id: 'att-1',
        binaryObjectId: 'binary-id-1',
        status: 'memory',
        blob: new Blob([''], { type: 'image/png' }),
        originalName: 'mem.png',
        mimeType: 'image/png',
        size: 10,
        uploadedAt: Date.now()
      }],
      replies: { items: [] },
    };

    vi.stubGlobal('URL', {
      createObjectURL: vi.fn().mockReturnValue('mock-url'),
      revokeObjectURL: vi.fn(),
    });

    const wrapper = mount(MessageItem, { props: { message } });
    await nextTick();
    await nextTick();

    const downloadBtn = wrapper.find('[data-testid="download-attachment"]');
    expect(downloadBtn.classes()).toContain('touch-visible');
  });
});

describe('MessageItem Abort Button', () => {
  const createAssistantMessage = (content: string): MessageNode => ({
    id: generateId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('renders the abort button when isGenerating is true', () => {
    const message = createAssistantMessage('Generation in progress...');
    const wrapper = mount(MessageItem, { props: { message, isGenerating: true } });

    const abortBtn = wrapper.find('[data-testid="message-abort-button"]');
    expect(abortBtn.exists()).toBe(true);
    expect(abortBtn.attributes('title')).toBe('Stop generation');
  });

  it('does not render the abort button when isGenerating is false', () => {
    const message = createAssistantMessage('Generation finished');
    const wrapper = mount(MessageItem, { props: { message, isGenerating: false } });

    const abortBtn = wrapper.find('[data-testid="message-abort-button"]');
    expect(abortBtn.exists()).toBe(false);
  });

  it('emits abort event when abort button is clicked', async () => {
    const message = createAssistantMessage('Generation in progress...');
    const wrapper = mount(MessageItem, { props: { message, isGenerating: true } });

    const abortBtn = wrapper.find('[data-testid="message-abort-button"]');
    await abortBtn.trigger('click');

    expect(wrapper.emitted('abort')).toBeTruthy();
  });

  it('has the correct subtle styling for the abort button', () => {
    const message = createAssistantMessage('Generation in progress...');
    const wrapper = mount(MessageItem, { props: { message, isGenerating: true } });

    const abortBtn = wrapper.find('[data-testid="message-abort-button"]');
    const cls = abortBtn.classes();
    expect(cls).toContain('text-gray-400');
    expect(cls).toContain('hover:text-red-500');
    expect(cls).not.toContain('animate-pulse');
  });
});

describe('MessageItem Actions Menu', () => {
  const createMessage = (content: string): MessageNode => ({
    id: generateId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  it('toggles the actions menu when the more-actions button is clicked', async () => {
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, { props: { message } });

    const menuButton = wrapper.find('[data-testid="message-more-actions-button"]');
    expect(menuButton.exists()).toBe(true);

    // Menu should be hidden by default
    expect(wrapper.find('.absolute.right-0.bottom-full').exists()).toBe(false);

    await menuButton.trigger('click');
    await nextTick();

    // Menu should be visible
    const menu = wrapper.find('.absolute.right-0.bottom-full');
    expect(menu.exists()).toBe(true);
    expect(menu.text()).toContain('Compare Versions');
  });

  it('opens the MessageDiffModal when "Compare Versions" is clicked', async () => {
    const message = createMessage('Hello');
    const wrapper = mount(MessageItem, {
      props: { message },
      global: {
        stubs: {
          MessageDiffModal: {
            template: '<div data-testid="message-diff-modal"></div>'
          }
        }
      }
    });

    // Open menu
    await wrapper.find('[data-testid="message-more-actions-button"]').trigger('click');
    await nextTick();

    const compareBtn = wrapper.findAll('button').find(b => b.text().includes('Compare Versions'));
    expect(compareBtn?.exists()).toBe(true);

    await compareBtn?.trigger('click');
    await nextTick();

    // Check if MessageDiffModal is triggered
    const modal = wrapper.find('[data-testid="message-diff-modal"]');
    expect(modal.exists()).toBe(true);
  });
});
