import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ConversationOutlineOverlay from './ConversationOutlineOverlay.vue';
import type { ChatFlowItem } from '@/composables/useChatDisplayFlow';
import type { MessageNode } from '@/01-models/types';
import { toMessageId, toChatId } from '@/01-models/ids';

vi.mock('./MessageItem.vue', () => ({
  default: {
    name: 'MessageItem',
    props: ['message', 'chatId', 'partContent'],
    template: '<div data-testid="message-content">{{ partContent || message.content }}</div>',
  },
}));

type OutlineTestRole = Exclude<MessageNode['role'], 'tool'>;

function messageFlowItem({ id, role, content }: {
  id: string,
  role: OutlineTestRole,
  content: string,
}): ChatFlowItem {
  return {
    type: 'message',
    node: { id: toMessageId({ raw: id }), role, content, timestamp: 0, replies: { items: [] } },
    mode: 'content',
    flow: { position: 'standalone', nesting: 'none' },
    isFirstInNode: true,
    isLastInNode: true,
    isFirstInTurn: true,
  };
}

describe('ConversationOutlineOverlay', () => {
  it('renders content messages as a compact outline', () => {
    const wrapper = mount(ConversationOutlineOverlay, {
      props: {
        chatId: toChatId({ raw: 'chat-1' }),
        visibility: 'visible',
        flowItems: [
          messageFlowItem({ id: 'u1', role: 'user', content: 'First user message' }),
          messageFlowItem({ id: 'a1', role: 'assistant', content: 'Assistant answer' }),
        ],
      },
    });

    expect(wrapper.find('[data-testid="conversation-outline-overlay"]').classes()).toContain('z-40');
    expect(wrapper.find('[data-testid="conversation-outline-panel"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('First user message');
    expect(wrapper.text()).toContain('Assistant answer');
    expect(wrapper.findAll('[data-testid="conversation-outline-item"]')).toHaveLength(2);
  });

  it('emits close and selected message events', async () => {
    const wrapper = mount(ConversationOutlineOverlay, {
      props: {
        chatId: toChatId({ raw: 'chat-1' }),
        visibility: 'visible',
        flowItems: [
          messageFlowItem({ id: 'u1', role: 'user', content: 'First user message' }),
        ],
      },
    });

    await wrapper.find('[data-testid="conversation-outline-jump-button"]').trigger('click');
    await wrapper.find('[data-testid="close-conversation-outline-button"]').trigger('click');

    expect(wrapper.emitted('select-message')).toEqual([['u1']]);
    expect(wrapper.emitted('close')).toEqual([[]]);
  });

  it('opens a MessageItem peek from the row edge without selecting the message', async () => {
    const wrapper = mount(ConversationOutlineOverlay, {
      props: {
        chatId: toChatId({ raw: 'chat-1' }),
        visibility: 'visible',
        flowItems: [
          messageFlowItem({ id: 'u1', role: 'user', content: 'Peekable user message' }),
        ],
      },
    });

    await wrapper.find('[data-testid="conversation-outline-peek-button"]').trigger('click');

    expect(wrapper.find('[data-testid="conversation-outline-peek"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="message-content"]').text()).toContain('Peekable user message');
    expect(wrapper.emitted('select-message')).toBeUndefined();
  });

  it('expands the outline height while a peek is open', async () => {
    const wrapper = mount(ConversationOutlineOverlay, {
      props: {
        chatId: toChatId({ raw: 'chat-1' }),
        visibility: 'visible',
        flowItems: [
          messageFlowItem({ id: 'u1', role: 'user', content: 'Peekable user message' }),
        ],
      },
    });

    const panel = wrapper.find('[data-testid="conversation-outline-panel"]');
    const body = wrapper.find('[data-testid="conversation-outline-body"]');
    expect(panel.classes()).toContain('max-h-[55vh]');
    expect(body.classes()).toContain('max-h-[calc(55vh-41px)]');

    const peekButton = wrapper.find('[data-testid="conversation-outline-peek-button"]');
    await peekButton.trigger('click');

    expect(panel.classes()).toContain('max-h-[80vh]');
    expect(body.classes()).toContain('max-h-[calc(80vh-41px)]');

    await peekButton.trigger('click');

    expect(panel.classes()).toContain('max-h-[55vh]');
    expect(body.classes()).toContain('max-h-[calc(55vh-41px)]');
  });

  it('shows scroll hints only when more outline content is available', async () => {
    const wrapper = mount(ConversationOutlineOverlay, {
      props: {
        chatId: toChatId({ raw: 'chat-1' }),
        visibility: 'visible',
        flowItems: Array.from({ length: 12 }, (_, index) => messageFlowItem({
          id: `u${index}`,
          role: 'user',
          content: `Long enough message ${index}`,
        })),
      },
    });

    const body = wrapper.find('[data-testid="conversation-outline-body"]');
    Object.defineProperty(body.element, 'clientHeight', { configurable: true, value: 120 });
    Object.defineProperty(body.element, 'scrollHeight', { configurable: true, value: 360 });
    Object.defineProperty(body.element, 'scrollTop', { configurable: true, value: 0 });

    await body.trigger('scroll');
    await nextTick();

    expect(wrapper.find('[data-testid="conversation-outline-scroll-hint-top"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="conversation-outline-scroll-hint-bottom"]').exists()).toBe(true);

    Object.defineProperty(body.element, 'scrollTop', { configurable: true, value: 240 });
    await body.trigger('scroll');
    await nextTick();

    expect(wrapper.find('[data-testid="conversation-outline-scroll-hint-top"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="conversation-outline-scroll-hint-bottom"]').exists()).toBe(false);
  });

  it('scrolls the initially visible chat message into the outline when opened', async () => {
    const wrapper = mount(ConversationOutlineOverlay, {
      props: {
        chatId: toChatId({ raw: 'chat-1' }),
        visibility: 'visible',
        flowItems: Array.from({ length: 8 }, (_, index) => messageFlowItem({
          id: `m${index}`,
          role: 'user',
          content: `Message ${index}`,
        })),
      },
    });

    const body = wrapper.find('[data-testid="conversation-outline-body"]');
    const scrollTo = vi.fn();
    Object.defineProperty(body.element, 'scrollTo', { configurable: true, value: scrollTo });
    Object.defineProperty(body.element, 'scrollTop', { configurable: true, value: 0 });
    Object.defineProperty(body.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, bottom: 100, height: 100 }),
    });

    const rows = wrapper.findAll('[data-testid="conversation-outline-item"]');
    for (const [index, row] of rows.entries()) {
      Object.defineProperty(row.element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: index * 40, bottom: index * 40 + 20, height: 20 }),
      });
    }

    await wrapper.setProps({ initialMessageId: toMessageId({ raw: 'm5' }) });
    await nextTick();

    expect(scrollTo).toHaveBeenCalledWith({
      top: 160,
      behavior: 'auto',
    });
  });

  it('does not re-scroll to the initial message when a peek is toggled', async () => {
    const wrapper = mount(ConversationOutlineOverlay, {
      props: {
        chatId: toChatId({ raw: 'chat-1' }),
        visibility: 'visible',
        initialMessageId: toMessageId({ raw: 'm5' }),
        flowItems: Array.from({ length: 8 }, (_, index) => messageFlowItem({
          id: `m${index}`,
          role: 'user',
          content: `Message ${index}`,
        })),
      },
    });

    const body = wrapper.find('[data-testid="conversation-outline-body"]');
    const scrollTo = vi.fn();
    Object.defineProperty(body.element, 'scrollTo', { configurable: true, value: scrollTo });
    Object.defineProperty(body.element, 'scrollTop', { configurable: true, value: 0 });
    Object.defineProperty(body.element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ top: 0, bottom: 100, height: 100 }),
    });

    const rows = wrapper.findAll('[data-testid="conversation-outline-item"]');
    for (const [index, row] of rows.entries()) {
      Object.defineProperty(row.element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ top: index * 40, bottom: index * 40 + 20, height: 20 }),
      });
    }

    await wrapper.setProps({ initialMessageId: toMessageId({ raw: 'm4' }) });
    await nextTick();
    scrollTo.mockClear();

    await wrapper.find('[data-testid="conversation-outline-peek-button"]').trigger('click');
    await nextTick();

    expect(scrollTo).not.toHaveBeenCalled();
  });
});
