import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { mount } from '@vue/test-utils';
import { computed, nextTick } from 'vue';
import ConversationOutlineOverlay from './ConversationOutlineOverlay.vue';
import { useChatDisplayFlow, type ChatFlowItem } from '@/composables/useChatDisplayFlow';
import type { AssistantMessageNode, Chat, MessageNode } from '@/01-models/types';
import { toMessageId, toChatId } from '@/01-models/ids';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

vi.mock('./MessageItem.vue', () => ({
  default: {
    name: 'MessageItem',
    props: ['message', 'chatId', 'partContent'],
    template: '<div data-testid="message-content">{{ partContent }}</div>',
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
    key: JSON.stringify([id, 'p1']),
    partContent: content,
    node: {
      id: toMessageId({ raw: id }), role, createdAt: 0, replies: { items: [] },
      modelId: undefined, lmParameters: undefined, interruption: undefined,
      parts: [{ id: 'p1', type: 'text', text: content, completeness: 'complete' }],
    },
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


function structuredFlow({ parts }: { parts: AssistantMessageNode['parts'] }) {
  const node: AssistantMessageNode = {
    id: toMessageId({ raw: 'parts-assistant' }), role: 'assistant', createdAt: 0,
    modelId: undefined, lmParameters: undefined, interruption: { type: 'cancelled' },
    parts, replies: { items: [] },
  };
  const chat: Chat = { id: toChatId({ raw: 'parts-chat' }), title: 'Parts', createdAt: 0, updatedAt: 0,
    debugEnabled: false, root: { items: [node] }, currentLeafId: node.id,
  };
  return { node, chat, ...useChatDisplayFlow({ chat: computed(() => chat), isProcessing: () => false }) };
}

describe('outline navigation over message parts', () => {
  it('keeps one navigation row and one peek for several text parts of the same assistant', async () => {
    const { node, chat, chatFlow } = structuredFlow({ parts: [
      { id: 'a', type: 'text', text: 'First ', completeness: 'complete' },
      { id: 'r', type: 'reasoning', text: 'Do not put this in the outline.', completeness: 'complete' },
      { id: 'b', type: 'text', text: 'second', completeness: 'partial' },
    ] });
    const before = structuredClone(node);
    const wrapper = mount(ConversationOutlineOverlay, { props: { chatId: chat.id, visibility: 'visible', flowItems: chatFlow.value } });
    expect(wrapper.findAll('[data-testid="conversation-outline-item"]')).toHaveLength(1);
    expect(wrapper.text()).toContain('First second');
    expect(wrapper.text()).not.toContain('Do not put this');
    await wrapper.find('[data-testid="conversation-outline-peek-button"]').trigger('click');
    expect(wrapper.findAll('[data-testid="conversation-outline-peek"]')).toHaveLength(1);
    expect(wrapper.findComponent({ name: 'MessageItem' }).props('partContent')).toBe('First second');
    await wrapper.find('[data-testid="conversation-outline-jump-button"]').trigger('click');
    expect(wrapper.emitted('select-message')).toEqual([[node.id]]);
    expect(node).toEqual(before);
    wrapper.unmount();
  });

  it('does not preserve an old peek across a chat change, even when the message id is reused', async () => {
    const item = messageFlowItem({ id: 'reused', role: 'assistant', content: 'First chat' });
    const wrapper = mount(ConversationOutlineOverlay, { props: { chatId: toChatId({ raw: 'first' }), visibility: 'visible', flowItems: [item] } });
    await wrapper.find('[data-testid="conversation-outline-peek-button"]').trigger('click');
    expect(wrapper.findAll('[data-testid="conversation-outline-peek"]')).toHaveLength(1);
    await wrapper.setProps({ chatId: toChatId({ raw: 'second' }), flowItems: [messageFlowItem({ id: 'reused', role: 'assistant', content: 'Second chat' })] });
    expect(wrapper.find('[data-testid="conversation-outline-peek"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="conversation-outline-panel"]').classes()).toContain('max-h-[55vh]');
    wrapper.unmount();
  });

  it('forgets a removed or hidden peek instead of reviving it with a later row', async () => {
    const item = messageFlowItem({ id: 'removed', role: 'assistant', content: 'Original' });
    const wrapper = mount(ConversationOutlineOverlay, { props: { chatId: toChatId({ raw: 'c' }), visibility: 'visible', flowItems: [item] } });
    await wrapper.find('[data-testid="conversation-outline-peek-button"]').trigger('click');
    await wrapper.setProps({ flowItems: [] });
    await wrapper.setProps({ flowItems: [item] });
    expect(wrapper.find('[data-testid="conversation-outline-peek"]').exists()).toBe(false);
    await wrapper.find('[data-testid="conversation-outline-peek-button"]').trigger('click');
    await wrapper.setProps({ visibility: 'hidden' });
    await wrapper.setProps({ visibility: 'visible' });
    expect(wrapper.find('[data-testid="conversation-outline-peek"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shortens only the preview and keeps literal-tag source text and partial state intact', async () => {
    const raw = `<think>Displayed separately</think> A

B `;
    const { node, chat, chatFlow } = structuredFlow({ parts: [
      { id: 'body', type: 'text', text: raw, completeness: 'partial' },
    ] });
    const before = structuredClone(node);
    const wrapper = mount(ConversationOutlineOverlay, { props: { chatId: chat.id, visibility: 'visible', flowItems: chatFlow.value } });
    expect(wrapper.text()).toContain('A B');
    expect(wrapper.text()).not.toContain('Displayed separately');
    await wrapper.find('[data-testid="conversation-outline-peek-button"]').trigger('click');
    expect(wrapper.findComponent({ name: 'MessageItem' }).props('partContent')).toBe(` A

B `);
    expect(node).toEqual(before);
    wrapper.unmount();
  });

  it('keeps identical text in distinct messages as separate navigation rows', () => {
    const wrapper = mount(ConversationOutlineOverlay, { props: { chatId: toChatId({ raw: 'c' }), visibility: 'visible', flowItems: [
      messageFlowItem({ id: 'first', role: 'assistant', content: 'Same' }),
      messageFlowItem({ id: 'second', role: 'assistant', content: 'Same' }),
    ] } });
    expect(wrapper.findAll('[data-testid="conversation-outline-item"]')).toHaveLength(2);
    wrapper.unmount();
  });
});


describe('outline identity during generation and history changes', () => {
  it('retains the row and its open peek when an earlier empty part starts emitting text', async () => {
    const initial = structuredFlow({ parts: [
      { id: 'first', type: 'text', text: '', completeness: 'partial' },
      { id: 'second', type: 'text', text: 'B', completeness: 'complete' },
    ] });
    const wrapper = mount(ConversationOutlineOverlay, { props: { chatId: initial.chat.id, visibility: 'visible', flowItems: initial.chatFlow.value } });
    const row = wrapper.find('[data-testid="conversation-outline-item"]').element;
    await wrapper.find('[data-testid="conversation-outline-peek-button"]').trigger('click');
    const updated = structuredFlow({ parts: [
      { id: 'first', type: 'text', text: 'A ', completeness: 'partial' },
      { id: 'second', type: 'text', text: 'B', completeness: 'complete' },
    ] });
    await wrapper.setProps({ flowItems: updated.chatFlow.value });
    expect(wrapper.findAll('[data-testid="conversation-outline-item"]')).toHaveLength(1);
    expect(wrapper.find('[data-testid="conversation-outline-item"]').element).toBe(row);
    expect(wrapper.findAll('[data-testid="conversation-outline-peek"]')).toHaveLength(1);
    expect(wrapper.findComponent({ name: 'MessageItem' }).props('partContent')).toBe('A B');
    wrapper.unmount();
  });

  it('keeps an empty cancelled assistant navigable without treating partial as live generation', () => {
    const { node, chat, chatFlow } = structuredFlow({ parts: [
      { id: 'first', type: 'text', text: '', completeness: 'partial' },
      { id: 'second', type: 'text', text: '', completeness: 'complete' },
    ] });
    const before = structuredClone(node);
    const wrapper = mount(ConversationOutlineOverlay, { props: { chatId: chat.id, visibility: 'visible', flowItems: chatFlow.value } });
    expect(wrapper.findAll('[data-testid="conversation-outline-item"]')).toHaveLength(1);
    expect(wrapper.text()).toContain('(empty message)');
    expect(node).toEqual(before);
    wrapper.unmount();
  });

  it('retains the explicit tool-results placeholder without exposing the result in the outline', async () => {
    const node: MessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 0, modelId: undefined, lmParameters: undefined, parts: [], replies: { items: [] } };
    const item: ChatFlowItem = { type: 'message', key: 'tool-placeholder', node, partContent: '[Tool Results]', mode: 'content', flow: { position: 'standalone', nesting: 'none' }, isFirstInNode: true, isLastInNode: true, isFirstInTurn: false };
    const wrapper = mount(ConversationOutlineOverlay, { props: { chatId: toChatId({ raw: 'c' }), visibility: 'visible', flowItems: [item] } });
    expect(wrapper.text()).toContain('[Tool Results]');
    await wrapper.find('[data-testid="conversation-outline-peek-button"]').trigger('click');
    expect(wrapper.findComponent({ name: 'MessageItem' }).props('partContent')).toBe('[Tool Results]');
    wrapper.unmount();
  });
});
