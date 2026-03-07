import { generateId } from '../utils/id';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import ToolCallGroupItem from './ToolCallGroupItem.vue';
import type { MessageNode, AssistantMessageNode, CombinedToolCall } from '../models/types';
import { ref } from 'vue';
import { useSettings } from '../composables/useSettings';

vi.mock('../composables/useSettings', () => ({
  useSettings: vi.fn(),
}));

describe('AI Sequence Design', () => {
  const createAssistantMessage = (content: string): AssistantMessageNode => ({
    id: generateId(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
    replies: { items: [] },
  });

  const createToolCalls = (names: string[]): CombinedToolCall[] => {
    return names.map(name => ({
      id: generateId(),
      nodeId: generateId(),
      call: {
        id: generateId(),
        type: 'function',
        function: { name, arguments: '{}' }
      },
      result: { toolCallId: '', status: 'success', content: { type: 'text', text: 'ok' } }
    }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useSettings as any).mockReturnValue({
      settings: ref({ experimental: { markdownRendering: 'monolithic_html' } }),
    });
  });

  describe('MessageItem AI Sequence Styling', () => {
    it('hides header when isContinuation is true', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, isContinuation: true }
      });

      // The header contains the model name and icon
      // It's wrapped in a div with v-if="!isContinuation"
      expect(wrapper.find('.flex.items-center.gap-3.mb-1').exists()).toBe(false);
    });

    it('shows header when isContinuation is false', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, isContinuation: false }
      });

      expect(wrapper.find('.flex.items-center.gap-3.mb-1').exists()).toBe(true);
    });

    it('applies pt-0 and removes border-t when isContinuation is true', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, isContinuation: true }
      });

      const root = wrapper.find('.flex.flex-col');
      expect(root.classes()).toContain('pt-0');
      expect(root.classes()).not.toContain('border-t');
    });

    it('applies border-t when isContinuation is false for assistant', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, isContinuation: false }
      });

      const root = wrapper.find('.flex.flex-col');
      expect(root.classes()).toContain('border-t');
    });

    it('applies border-b only when isLastInSequence is true', () => {
      const message = createAssistantMessage('Hello');
      
      const lastWrapper = mount(MessageItem, {
        props: { message, isLastInSequence: true }
      });
      expect(lastWrapper.find('.flex.flex-col').classes()).toContain('border-b');

      const notLastWrapper = mount(MessageItem, {
        props: { message, isLastInSequence: false }
      });
      expect(notLastWrapper.find('.flex.flex-col').classes()).not.toContain('border-b');
    });

    it('applies pb-1 when not last in sequence to tighten the gap', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, isLastInSequence: false }
      });

      expect(wrapper.find('.flex.flex-col').classes()).toContain('pb-1');
    });
  });

  describe('ToolCallGroupItem AI Sequence Styling', () => {
    it('applies pt-0 and removes border-t when isContinuation is true', () => {
      const toolCalls = createToolCalls(['search']);
      const wrapper = mount(ToolCallGroupItem, {
        props: { toolCalls, isContinuation: true }
      });

      const root = wrapper.find('[data-testid="tool-call-group"]');
      expect(root.classes()).toContain('pt-0');
      expect(root.classes()).not.toContain('border-t');
    });

    it('applies border-b and pb-3 only when isLastInSequence is true', () => {
      const toolCalls = createToolCalls(['search']);
      
      const lastWrapper = mount(ToolCallGroupItem, {
        props: { toolCalls, isLastInSequence: true }
      });
      const lastRoot = lastWrapper.find('[data-testid="tool-call-group"]');
      expect(lastRoot.classes()).toContain('border-b');
      expect(lastWrapper.find('.px-5').classes()).toContain('pb-3');

      const notLastWrapper = mount(ToolCallGroupItem, {
        props: { toolCalls, isLastInSequence: false }
      });
      const notLastRoot = notLastWrapper.find('[data-testid="tool-call-group"]');
      expect(notLastRoot.classes()).not.toContain('border-b');
      expect(notLastWrapper.find('.px-5').classes()).toContain('pb-1');
    });

    it('shows repeated tool names in the summary', () => {
      const toolCalls = createToolCalls(['search', 'search', 'fetch']);
      const wrapper = mount(ToolCallGroupItem, {
        props: { toolCalls }
      });

      expect(wrapper.text()).toContain('Used search, search, fetch');
    });

    it('summarizes tool names when over the limit of 3', () => {
      const toolCalls = createToolCalls(['t1', 't2', 't3', 't4', 't5']);
      const wrapper = mount(ToolCallGroupItem, {
        props: { toolCalls }
      });

      expect(wrapper.text()).toContain('Used t1, t2, t3 and 2 more');
    });

    it('does not have uppercase header', () => {
      const toolCalls = createToolCalls(['search']);
      const wrapper = mount(ToolCallGroupItem, {
        props: { toolCalls }
      });

      const header = wrapper.find('[data-testid="tool-call-group-header"]');
      expect(header.classes()).not.toContain('uppercase');
    });
  });
});
