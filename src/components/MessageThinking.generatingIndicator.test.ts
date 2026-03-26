import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h, defineComponent, markRaw } from 'vue';
import MessageThinking from './MessageThinking.vue';
import type { MessageNode } from '@/models/types';

// A stub component used as trailingInline so we can assert its presence.
const TrailingStub = markRaw(defineComponent({
  name: 'TrailingStub',
  render() {
    return h('span', { 'data-testid': 'trailing-stub' });
  },
}));

const withInSequence = { global: { provide: { inSequence: true } } };

const createMessage = (content: string, thinking?: string): MessageNode => ({
  id: 'test-id',
  role: 'assistant',
  content,
  thinking,
  timestamp: Date.now(),
  replies: { items: [] },
});

describe('MessageThinking — trailingInline (GeneratingIndicator integration)', () => {
  describe('collapsed-active mode (thinking in progress)', () => {
    it('renders trailingInline inside the thinking content', () => {
      // Unclosed <think> tag → collapsed-active mode
      const message = createMessage('<think>Streaming thought...');
      const wrapper = mount(MessageThinking, {
        props: { message, trailingInline: TrailingStub },
      });

      expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });

    it('does not render trailingInline when prop is omitted', () => {
      const message = createMessage('<think>Streaming thought...');
      const wrapper = mount(MessageThinking, { props: { message } });

      expect(wrapper.find('[data-testid="trailing-stub"]').exists()).toBe(false);
    });

    it('trailing stub is inside the content container, not outside it', () => {
      const message = createMessage('<think>Streaming thought...');
      const wrapper = mount(MessageThinking, {
        props: { message, trailingInline: TrailingStub },
      });

      const content = wrapper.find('[data-testid="thinking-content"]');
      expect(content.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });
  });

  describe('expanded mode (user toggled open)', () => {
    it('renders trailingInline inside the thinking content when expanded', async () => {
      // closed <think> tag → collapsed-finished, then toggle to expanded
      const message = createMessage('Final answer', 'Completed thought');
      const wrapper = mount(MessageThinking, {
        props: { message, trailingInline: TrailingStub },
      });

      // Initially collapsed-finished, no content container
      expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);

      // Expand
      await wrapper.find('[data-testid="toggle-thinking"]').trigger('click');

      expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });

    it('trailing stub is inside the content container when expanded', async () => {
      const message = createMessage('Final answer', 'Completed thought');
      const wrapper = mount(MessageThinking, {
        props: { message, trailingInline: TrailingStub },
      });

      await wrapper.find('[data-testid="toggle-thinking"]').trigger('click');

      const content = wrapper.find('[data-testid="thinking-content"]');
      expect(content.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });
  });

  describe('collapsed-finished mode (thinking done, pill shown)', () => {
    it('renders trailingInline AFTER the pill wrapper when collapsed-finished', () => {
      const message = createMessage('Final answer', 'Completed thought');
      const wrapper = mount(MessageThinking, {
        props: { message, trailingInline: TrailingStub },
      });

      // No content container (v-if false)
      expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);
      // But the trailing stub should be present outside the toggle
      expect(wrapper.find('[data-testid="trailing-stub"]').exists()).toBe(true);
    });

    it('trailing stub is NOT inside the toggle-thinking container in collapsed-finished', () => {
      const message = createMessage('Final answer', 'Completed thought');
      const wrapper = mount(MessageThinking, {
        props: { message, trailingInline: TrailingStub },
      });

      const toggle = wrapper.find('[data-testid="toggle-thinking"]');
      expect(toggle.find('[data-testid="trailing-stub"]').exists()).toBe(false);
    });

    it('does not render trailingInline when prop is omitted in collapsed-finished', () => {
      const message = createMessage('Final answer', 'Completed thought');
      const wrapper = mount(MessageThinking, { props: { message } });

      expect(wrapper.find('[data-testid="trailing-stub"]').exists()).toBe(false);
    });

    it('renders trailingInline after pill in collapsed-finished when inSequence', () => {
      const message = createMessage('Final answer', 'Completed thought');
      const wrapper = mount(MessageThinking, {
        props: { message, trailingInline: TrailingStub },
        ...withInSequence,
      });

      expect(wrapper.find('[data-testid="trailing-stub"]').exists()).toBe(true);
      // The preview is shown (inSequence), content container is not
      expect(wrapper.find('[data-testid="thinking-preview"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="thinking-content"]').exists()).toBe(false);
    });
  });

  describe('trimEnd behavior during active thinking', () => {
    it('does not render a trailing newline before the indicator', () => {
      // Thinking text that ends with a newline — without trimEnd, indicator would
      // appear on the next line as the first character of an empty flex row.
      const message = createMessage('<think>Line one\nLine two\n');
      const wrapper = mount(MessageThinking, {
        props: { message, trailingInline: TrailingStub },
      });

      const contentEl = wrapper.find('[data-testid="thinking-content"]');
      // The span that holds both the text and the indicator component
      const innerSpan = contentEl.find('span');
      // The text content just before the stub should be trimmed (no trailing \n)
      const textContent = innerSpan.text();
      // Text should be present and the stub is right after it without a bare newline
      expect(textContent).toContain('Line one');
      expect(textContent).toContain('Line two');
    });
  });
});
