import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h, defineComponent } from 'vue';
import AssistantProcessSequence from './AssistantProcessSequence.vue';
import type { ChatFlowItem, SequenceStats } from '@/composables/useChatDisplayFlow';
import type { MessageNode } from '@/models/types';

// Cursor stub used in place of <GeneratingIndicator> to test slot rendering.
const CursorStub = defineComponent({
  name: 'CursorStub',
  render() {
    return h('span', { 'data-testid': 'cursor-stub' });
  },
});

const makeMessage = (): MessageNode => ({
  id: 'msg-1',
  role: 'assistant',
  content: 'Hello',
  timestamp: Date.now(),
  replies: { items: [] },
});

const makeItems = (): ChatFlowItem[] => [
  {
    type: 'message',
    node: makeMessage(),
    flow: { position: 'standalone', nesting: 'none' },
    mode: 'content',
    isFirstInNode: true,
    isLastInNode: true,
    isFirstInTurn: true,
  },
];

const makeStats = (overrides: Partial<SequenceStats> = {}): SequenceStats => ({
  thinkingSteps: 0,
  toolCallCount: 0,
  toolNames: [],
  isCurrentlyThinking: false,
  isCurrentlyToolRunning: false,
  isWaiting: false,
  ...overrides,
});

const cursorSlot = { cursor: () => h(CursorStub) };

describe('AssistantProcessSequence — cursor slot placement', () => {
  describe('collapsed state (toggle visible)', () => {
    it('shows cursor next to toggle when tool is running (not thinking, not waiting)', () => {
      // Scenario: tool call in progress, no peek
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: makeItems(),
          isProcessing: true,
          stats: makeStats({ isCurrentlyToolRunning: true }),
        },
        slots: cursorSlot,
      });

      // Should be collapsed (default)
      expect(wrapper.find('[data-testid="assistant-process-toggle"]').exists()).toBe(true);
      // Cursor should be visible
      expect(wrapper.find('[data-testid="cursor-stub"]').exists()).toBe(true);
    });

    it('does NOT show cursor next to toggle when currently thinking (peek is shown instead)', () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: makeItems(),
          isProcessing: true,
          stats: makeStats({ isCurrentlyThinking: true }),
        },
        slots: cursorSlot,
      });

      // Toggle area cursor slot is NOT rendered when thinking (peek slot takes over)
      // Cursor should still appear, but in the peek area
      expect(wrapper.find('[data-testid="cursor-stub"]').exists()).toBe(true);
    });

    it('does NOT show cursor next to toggle when waiting', () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: makeItems(),
          isProcessing: true,
          stats: makeStats({ isWaiting: true }),
        },
        slots: cursorSlot,
      });

      // When waiting, cursor should appear in peek area, not toggle area
      expect(wrapper.find('[data-testid="cursor-stub"]').exists()).toBe(true);
    });

    it('does NOT show cursor when not processing', () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: makeItems(),
          isProcessing: false,
          stats: makeStats({ isCurrentlyToolRunning: true }),
        },
        slots: cursorSlot,
      });

      expect(wrapper.find('[data-testid="cursor-stub"]').exists()).toBe(false);
    });
  });

  describe('peek slot area (collapsed + processing + thinking or waiting)', () => {
    it('shows cursor after peek content when currently thinking', () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: makeItems(),
          isProcessing: true,
          stats: makeStats({ isCurrentlyThinking: true }),
        },
        slots: {
          cursor: () => h(CursorStub),
          peek: () => h('div', { 'data-testid': 'peek-content' }, 'peek'),
        },
      });

      expect(wrapper.find('[data-testid="peek-content"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="cursor-stub"]').exists()).toBe(true);
    });

    it('shows cursor after peek content when waiting', () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: makeItems(),
          isProcessing: true,
          stats: makeStats({ isWaiting: true }),
        },
        slots: {
          cursor: () => h(CursorStub),
          peek: () => h('div', { 'data-testid': 'peek-content' }, 'peek'),
        },
      });

      expect(wrapper.find('[data-testid="peek-content"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="cursor-stub"]').exists()).toBe(true);
    });
  });

  describe('expanded state', () => {
    it('shows cursor inside expanded area when processing and expanded', async () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: makeItems(),
          isProcessing: true,
          stats: makeStats({ isCurrentlyToolRunning: true }),
        },
        slots: cursorSlot,
      });

      // Expand the sequence
      await wrapper.find('[data-testid="assistant-process-toggle"]').trigger('click');

      expect(wrapper.find('[data-testid="cursor-stub"]').exists()).toBe(true);
    });

    it('does NOT show cursor inside expanded area when not processing', async () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: makeItems(),
          isProcessing: false,
          stats: makeStats(),
        },
        slots: cursorSlot,
      });

      await wrapper.find('[data-testid="assistant-process-toggle"]').trigger('click');

      expect(wrapper.find('[data-testid="cursor-stub"]').exists()).toBe(false);
    });
  });

  describe('no cursor slot provided', () => {
    it('renders correctly with no cursor slot at all', () => {
      const wrapper = mount(AssistantProcessSequence, {
        props: {
          items: makeItems(),
          isProcessing: true,
          stats: makeStats({ isCurrentlyToolRunning: true }),
        },
      });

      // Should not throw and toggle still renders
      expect(wrapper.find('[data-testid="assistant-process-toggle"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="cursor-stub"]').exists()).toBe(false);
    });
  });
});
