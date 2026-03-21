import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import MessageItem from './MessageItem.vue';
import AssistantProcessSequence from './AssistantProcessSequence.vue';
import ToolCallGroupItem from './ToolCallGroupItem.vue';
import { generateId } from '@/utils/id';
import type { MessageNode } from '@/models/types';

// Mock Lucide icons to simplify DOM inspection
vi.mock('lucide-vue-next', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    Bird: { render: () => h('span', { 'data-testid': 'icon-bird' }) },
    User: { render: () => h('span', { 'data-testid': 'icon-user' }) },
    Eye: { render: () => h('span', { 'data-testid': 'icon-eye' }) },
    EyeOff: { render: () => h('span', { 'data-testid': 'icon-eye-off' }) },
  };
});

describe('Assistant Turn Visual Logic', () => {
  /**
   * Swift-style helper to create a base node.
   */
  const createBaseNode = ({ role, modelId }: { role: 'user' | 'assistant' | 'tool', modelId?: string }): MessageNode => ({
    id: generateId(),
    role,
    content: '',
    timestamp: Date.now(),
    modelId,
    replies: { items: [] }
  } as any);

  describe('Header Visibility (Icon + ModelID)', () => {
    it('Pattern 1: Assistant turn starts with a Sequence -> Sequence must show header', () => {
      const node = createBaseNode({ role: 'assistant', modelId: 'test-model' });

      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: [{ type: 'message', node, mode: 'thinking', isFirstInNode: true, isLastInNode: false, isFirstInTurn: true, flow: { position: 'standalone', nesting: 'none' } }],
          isProcessing: false,
          isFirstInTurn: true
        }
      });

      expect(wrapper.find('[data-testid="icon-bird"]').exists()).toBe(true);
      expect(wrapper.text()).toContain('test-model');
    });

    it('Pattern 2: Assistant turn starts with Content -> MessageItem must show header', () => {
      const node = createBaseNode({ role: 'assistant', modelId: 'test-model' });

      const wrapper = mount(MessageItem, {
        props: {
          message: node,
          mode: 'content',
          isFirstInTurn: true,
          isNested: false,
          flow: { position: 'standalone', nesting: 'none' }
        }
      });

      expect(wrapper.find('[data-testid="icon-bird"]').exists()).toBe(true);
      expect(wrapper.text()).toContain('test-model');
    });

    it('Pattern 3: Inside a Sequence -> MessageItem must NOT show header even if isFirstInTurn is true', () => {
      const node = createBaseNode({ role: 'assistant' });

      const wrapper = mount(MessageItem, {
        props: {
          message: node,
          mode: 'thinking',
          isFirstInTurn: true,
          isNested: true,
          flow: { position: 'standalone', nesting: 'inside-group' }
        }
      });

      expect(wrapper.find('[data-testid="icon-bird"]').exists()).toBe(false);
    });

    it('Pattern 4: Mid-turn Content after a sequence -> MessageItem must NOT show header', () => {
      const node = createBaseNode({ role: 'assistant' });

      const wrapper = mount(MessageItem, {
        props: {
          message: node,
          mode: 'content',
          isFirstInTurn: false, // Turn already started with a sequence
          isNested: false,
          flow: { position: 'standalone', nesting: 'none' }
        }
      });

      expect(wrapper.find('[data-testid="icon-bird"]').exists()).toBe(false);
    });

    it('User Icon Restoration: User turn starts -> MessageItem must show User icon', () => {
      const node = createBaseNode({ role: 'user' });

      const wrapper = mount(MessageItem, {
        props: {
          message: node,
          mode: 'content',
          isFirstInTurn: true,
          isNested: false,
          flow: { position: 'standalone', nesting: 'none' }
        }
      });

      expect(wrapper.find('[data-testid="icon-user"]').exists()).toBe(true);
      expect(wrapper.text()).toContain('You');
    });
  });

  describe('Show/Less UI State', () => {
    it('switches between Eye and EyeOff icons based on expansion', async () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: { items: [], isProcessing: false }
      });

      // Default: Collapsed
      expect(wrapper.find('[data-testid="icon-eye"]').exists()).toBe(true);
      expect(wrapper.text().toUpperCase()).toContain('SHOW');

      // Click to expand
      await wrapper.find('[data-testid="assistant-process-toggle"]').trigger('click');

      expect(wrapper.find('[data-testid="icon-eye-off"]').exists()).toBe(true);
      expect(wrapper.text().toUpperCase()).toContain('LESS');
    });

    it('shows action labels only on hover (simulated via class check)', () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: { items: [], isProcessing: false }
      });

      const label = wrapper.find('.group-hover\\/seq\\:opacity-100');
      expect(label.exists()).toBe(true);
      expect(label.element.classList.contains('opacity-0')).toBe(true);
    });

    it('shows Loader icon instead of Eye when processing and thinking', () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: [],
          isProcessing: true,
          stats: { thinkingSteps: 1, toolCallCount: 0, toolNames: [], isCurrentlyThinking: true, isCurrentlyToolRunning: false, isWaiting: false }
        }
      });

      expect(wrapper.find('[data-testid="icon-loader"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="icon-eye"]').exists()).toBe(false);
    });

    it('renders the Peek slot when collapsed and processing', () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: [],
          isProcessing: true,
          stats: { thinkingSteps: 1, toolCallCount: 0, toolNames: [], isCurrentlyThinking: true, isCurrentlyToolRunning: false, isWaiting: false }
        },
        slots: {
          peek: '<div data-testid="peek-content">thinking...</div>'
        }
      });

      expect(wrapper.find('[data-testid="peek-content"]').exists()).toBe(true);
    });
  });

  describe('Nesting & Visual Continuity', () => {
    it('MessageItem removes background when isNested is true', () => {
      const node = createBaseNode({ role: 'assistant' });
      const wrapper = mount(MessageItem, {
        props: {
          message: node,
          isNested: true,
          flow: { position: 'middle', nesting: 'inside-group' }
        }
      });

      // Should not have the specific background class for standalone assistant messages
      expect(wrapper.classes()).not.toContain('bg-gray-50/30');
    });

    it('ToolCallGroupItem removes background when isNested is true', () => {
      const wrapper = mount(ToolCallGroupItem, {
        props: {
          toolCalls: [],
          flow: { position: 'middle', nesting: 'inside-group' }
        }
      });

      const container = wrapper.find('[data-testid="tool-call-group"]');
      if (container.exists()) {
        expect(container.classes()).not.toContain('bg-gray-50/30');
      }
    });
  });
});
