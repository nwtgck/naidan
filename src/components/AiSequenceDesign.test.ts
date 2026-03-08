import { generateId } from '../utils/id';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageItem from './MessageItem.vue';
import ToolCallGroupItem from './ToolCallGroupItem.vue';
import type { AssistantMessageNode, CombinedToolCall } from '../models/types';
import { ref } from 'vue';
import { useSettings } from '../composables/useSettings';
import type { FlowMetadata } from '../composables/useChatDisplayFlow';

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

  const flow = (position: 'standalone' | 'start' | 'middle' | 'end', nesting: 'none' | 'inside-group' = 'none'): FlowMetadata => ({
    position,
    nesting
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (useSettings as any).mockReturnValue({
      settings: ref({ experimental: { markdownRendering: 'monolithic_html' } }),
    });
  });

  describe('MessageItem AI Sequence Styling', () => {
    it('hides header when position is middle or end', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, flow: flow('middle') }
      });

      // showHeader is false for middle
      expect(wrapper.find('.flex.items-center.gap-3.mb-1').exists()).toBe(false);
    });

    it('shows header when position is standalone or start', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, flow: flow('start'), isFirstInTurn: true }
      });

      expect(wrapper.find('.flex.items-center.gap-3.mb-1').exists()).toBe(true);
    });

    it('applies pt-2 when position is middle or end', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, flow: flow('middle') }
      });

      const root = wrapper.find('.flex.flex-col');
      expect(root.classes()).toContain('pt-2');
    });

    it('applies border-t when position is standalone or start for assistant', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, flow: flow('start') }
      });

      const root = wrapper.find('.flex.flex-col');
      expect(root.classes()).toContain('border-t');
    });

    it('applies border-b only when position is standalone or end', () => {
      const message = createAssistantMessage('Hello');

      const lastWrapper = mount(MessageItem, {
        props: { message, flow: flow('end') }
      });
      expect(lastWrapper.find('.flex.flex-col').classes()).toContain('border-b');

      const notLastWrapper = mount(MessageItem, {
        props: { message, flow: flow('start') }
      });
      expect(notLastWrapper.find('.flex.flex-col').classes()).not.toContain('border-b');
    });

    it('applies pb-2 when NOT last in sequence', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, flow: flow('start') } // Not end or standalone
      });

      expect(wrapper.find('.flex.flex-col').classes()).toContain('pb-2');
    });

    it('removes specialized styling when nested inside a group', () => {
      const message = createAssistantMessage('Hello');
      const wrapper = mount(MessageItem, {
        props: { message, flow: flow('middle', 'inside-group') }
      });

      const root = wrapper.find('.flex.flex-col');
      expect(root.classes()).toContain('px-5');
      expect(root.classes()).not.toContain('p-5');
      expect(root.classes()).not.toContain('bg-gray-50/30'); // Background is delegated to parent
    });
  });

  describe('ToolCallGroupItem AI Sequence Styling', () => {
    it('applies pt-2 when position is middle or end', () => {
      const toolCalls = createToolCalls(['search']);
      const wrapper = mount(ToolCallGroupItem, {
        props: { toolCalls, flow: flow('middle') }
      });

      const root = wrapper.find('[data-testid="tool-call-group"]');
      expect(root.classes()).toContain('pt-2');
    });

    it('applies border-b and pb-3 only when position is standalone or end', () => {
      const toolCalls = createToolCalls(['search']);

      const lastWrapper = mount(ToolCallGroupItem, {
        props: { toolCalls, flow: flow('end') }
      });
      const lastRoot = lastWrapper.find('[data-testid="tool-call-group"]');
      expect(lastRoot.classes()).toContain('border-b');
      expect(lastWrapper.find('.px-5').classes()).toContain('pb-3');

      const notLastWrapper = mount(ToolCallGroupItem, {
        props: { toolCalls, flow: flow('start') }
      });
      const notLastRoot = notLastWrapper.find('[data-testid="tool-call-group"]');
      expect(notLastRoot.classes()).not.toContain('border-b');
      expect(notLastWrapper.find('.px-5').classes()).toContain('pb-2');
    });

    it('shows repeated tool names in the summary', () => {
      const toolCalls = createToolCalls(['search', 'search', 'fetch']);
      const wrapper = mount(ToolCallGroupItem, {
        props: { toolCalls, flow: flow('standalone') }
      });

      expect(wrapper.text()).toContain('Used search, search, fetch');
    });

    it('summarizes tool names when over the limit of 3', () => {
      const toolCalls = createToolCalls(['t1', 't2', 't3', 't4', 't5']);
      const wrapper = mount(ToolCallGroupItem, {
        props: { toolCalls, flow: flow('standalone') }
      });

      expect(wrapper.text()).toContain('Used t1, t2, t3 and 2 more');
    });
  });
});
