import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowMount } from '@vue/test-utils';
import { ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { toChatId, toMessageId } from '@/01-models/ids';
import type { MessageNode } from '@/01-models/types';
import MessageItem from './MessageItem.vue';
import AssistantWaitingIndicator from './AssistantWaitingIndicator.vue';
import LlamaCppBrowserLoadingIndicator from '@/features/llama-cpp-browser/components/LlamaCppBrowserLoadingIndicator.vue';

vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({}) }) }));
vi.mock('@/00-storage/service', () => ({ storageService: {
  getFile: vi.fn().mockResolvedValue(undefined), getBinaryObject: vi.fn().mockResolvedValue(undefined),
  subscribeToChanges: vi.fn().mockReturnValue(() => {}),
} }));
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});
describe('message-local llama.cpp preparation status', () => {
  const message: MessageNode = { id: toMessageId({ raw: 'preparing-message' }), role: 'assistant',
    parts: [], createdAt: 1, interruption: undefined, modelId: undefined, lmParameters: undefined, replies: { items: [] } };
  it('mounts preparation UI only inside the generating message and removes it after completion', async () => {
    const wrapper = shallowMount(MessageItem, { props: { chatId: toChatId({ raw: 'local-chat' }), message,
      endpointType: 'llama_cpp_browser', isGenerating: true, showGeneratingIndicator: true } });
    expect(wrapper.findComponent(LlamaCppBrowserLoadingIndicator).exists()).toBe(true);
    expect(wrapper.getComponent(LlamaCppBrowserLoadingIndicator).props('scope')).toBe('inference');
    await wrapper.setProps({ isGenerating: false });
    expect(wrapper.findComponent(LlamaCppBrowserLoadingIndicator).exists()).toBe(false);
    wrapper.unmount();
  });
  it('does not mount listeners in historic messages, other providers, or non-tail pieces', async () => {
    const wrapper = shallowMount(MessageItem, { props: { chatId: toChatId({ raw: 'local-chat' }), message,
      endpointType: 'llama_cpp_browser', isGenerating: false, showGeneratingIndicator: true } });
    expect(wrapper.findComponent(LlamaCppBrowserLoadingIndicator).exists()).toBe(false);
    await wrapper.setProps({ endpointType: 'transformers_js', isGenerating: true });
    expect(wrapper.findComponent(LlamaCppBrowserLoadingIndicator).exists()).toBe(false);
    await wrapper.setProps({ endpointType: 'llama_cpp_browser', showGeneratingIndicator: false });
    expect(wrapper.findComponent(LlamaCppBrowserLoadingIndicator).exists()).toBe(false);
    wrapper.unmount();
  });
  it('delegates waiting and preparation to one status owner without duplicate waiters', async () => {
    const wrapper = shallowMount(MessageItem, { props: { chatId: toChatId({ raw: 'local-chat' }), message,
      endpointType: 'llama_cpp_browser', mode: 'waiting', isGenerating: true, showGeneratingIndicator: true } });
    expect(wrapper.getComponent(LlamaCppBrowserLoadingIndicator).props('waiting')).toBe(true);
    expect(wrapper.findComponent(AssistantWaitingIndicator).exists()).toBe(false);
    await wrapper.setProps({ endpointType: 'openai' });
    expect(wrapper.findComponent(LlamaCppBrowserLoadingIndicator).exists()).toBe(false);
    expect(wrapper.findComponent(AssistantWaitingIndicator).exists()).toBe(true);
    wrapper.unmount();
  });
});
