import { computed, ref } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MessageItem from './MessageItem.vue';
import MessageThinking from './MessageThinking.vue';
import MessageActions from './MessageActions.vue';
import type { AssistantMessageNode } from '@/01-models/types';
import { toChatId, toMessageId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { useChatDisplayFlow } from '@/composables/useChatDisplayFlow';
import type { Chat } from '@/01-models/types';

vi.mock('@/00-storage/service', () => ({ storageService: { getFile: vi.fn().mockResolvedValue(null), getBinaryObject: vi.fn().mockResolvedValue(null), subscribeToChanges: vi.fn().mockReturnValue(() => {}) } }));

function assistant({ parts, interruption }: { parts: AssistantMessageNode['parts'], interruption: AssistantMessageNode['interruption'] }): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', parts, interruption, createdAt: 1, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
describe('message parts UI boundaries', () => {
  it('renders a recorded Japanese error unchanged under an English UI', () => {
    const message = assistant({ parts: [], interruption: { type: 'error', message: '通信に失敗しました。' } });
    const wrapper = mount(MessageItem, { props: { chatId: toChatId({ raw: 'c' }), message } });
    expect(wrapper.find('[data-testid="error-message"]').text()).toContain('通信に失敗しました。');
    expect(message.parts).toEqual([]); wrapper.unmount();
  });
  it('a cancelled native partial is displayed without a running border or a fabricated tag', () => {
    const message = assistant({ parts: [{ id: 'r', type: 'reasoning', text: '  途中の理由', completeness: 'partial' }], interruption: { type: 'cancelled' } });
    const wrapper = mount(MessageItem, { props: { chatId: toChatId({ raw: 'c' }), message, mode: 'thinking' } });
    expect(wrapper.findComponent(MessageThinking).exists()).toBe(true);
    expect(wrapper.find('.thinking-gradient-border').exists()).toBe(false);
    expect(message.parts[0]).toEqual({ id: 'r', type: 'reasoning', text: '  途中の理由', completeness: 'partial' }); wrapper.unmount();
  });
  it('copy raw uses the original text instead of the read-only thinking projection', async () => {
    const raw = '<think> R </think> Answer\n';
    const message = assistant({ parts: [{ id: 't', type: 'text', text: raw, completeness: 'complete' }], interruption: undefined });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const wrapper = mount(MessageActions, { props: { chatId: toChatId({ raw: 'c' }), message, isImageResponse: false, isUser: false, isGenerating: false, speechText: 'Answer', displayContent: 'Answer', showExtensions: false }, attachTo: document.body });
    await wrapper.find('[data-testid="message-more-actions-button"]').trigger('click');
    await flushPromises();
    const rawButton = document.body.querySelector<HTMLButtonElement>('[data-testid="copy-raw-button"]');
    expect(rawButton).not.toBeNull(); rawButton!.click(); await flushPromises();
    expect(writeText).toHaveBeenCalledWith(raw);
    expect(message.parts[0]).toMatchObject({ text: raw }); wrapper.unmount();
  });
  it('empty earlier text becoming visible does not change the later reasoning identity', () => {
    const message = assistant({ parts: [{ id: 't', type: 'text', text: '', completeness: 'partial' }, { id: 'r', type: 'reasoning', text: 'R', completeness: 'partial' }], interruption: undefined });
    const chat = ref({ id: toChatId({ raw: 'c' }), root: { items: [message] }, currentLeafId: message.id } as Chat);
    const { chatFlow } = useChatDisplayFlow({ chat: computed(() => chat.value), isProcessing: () => true });
    const first = chatFlow.value[0];
    expect(first?.type).toBe('message');
    const node = chat.value.root.items[0]; const part = node?.parts[0];
    if (part?.type !== 'text') throw new Error('Missing test part.'); part.text = 'A';
    const second = chatFlow.value[1];
    expect(second?.type === 'message' && second.key).toBe(first?.type === 'message' && first.key);
  });
  it('edit emits the complete raw body with whitespace instead of its rendered projection', async () => {
    const raw = '<think>Reason</think> Body \n';
    const message = assistant({ parts: [{ id: 't', type: 'text', text: raw, completeness: 'complete' }], interruption: undefined });
    const wrapper = mount(MessageItem, { props: { chatId: toChatId({ raw: 'c' }), message } });
    await wrapper.find('[data-testid="edit-message-button"]').trigger('click');
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="edit-textarea"]');
    expect(textarea.element.value).toBe(raw);
    await wrapper.find('[data-testid="save-edit"]').trigger('click');
    expect(wrapper.emitted('edit')?.[0]?.[1]).toBe(raw); wrapper.unmount();
  });
});
