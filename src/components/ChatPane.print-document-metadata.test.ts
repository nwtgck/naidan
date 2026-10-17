import { flushPromises, shallowMount } from '@vue/test-utils';
import { computed, defineComponent, h, ref } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toChatId } from '@/01-models/ids';
import type { Chat } from '@/01-models/types';
import { provideDocumentMetadata } from '@/composables/useDocumentMetadata';
import { usePrint } from '@/composables/usePrint';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { setupScrollToMock } from '@/utils/utils.test-support';
import ChatPane from './ChatPane.vue';

const chat: Chat = { id: toChatId({ raw: 'print-chat' }), groupId: undefined, title: 'Named printed chat', root: { items: [] }, debugEnabled: false, createdAt: 1, updatedAt: 1 };
vi.mock('@/composables/useAppPresentation', () => ({
  isAppInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled',
  useAppPresentation: () => ({ appInteraction: ref('enabled') }),
}));
vi.mock('@/composables/chat/ui/useChatPaneState', () => ({
  useChatPaneState: () => ({
    chat: computed(() => chat),
    chatGroup: computed(() => null),
    activeMessages: computed(() => []),
    allMessages: computed(() => []),
    resolvedSettings: computed(() => null),
    inheritedSettings: computed(() => null),
    chatGroups: computed(() => []),
  }),
}));
vi.mock('@/composables/chat/useChatModels', () => ({
  useChatModels: () => ({
    availableModels: ref([]),
    fetchingModels: computed(() => false),
    fetchForChat: vi.fn(async () => []),
  }),
}));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  setupScrollToMock();
  document.head.innerHTML = '';
});

describe('ChatPane print document metadata', () => {
  it('keeps the captured document owner when the real pane header emits print after setup', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/chat/:id', component: {} }] });
    await router.push('/chat/print-chat');
    const wrapper = shallowMount(defineComponent({
      setup() {
        provideDocumentMetadata({ router, document, homeIntroduction: ref({ kind: 'inactive' }), continueHomeIntroduction: () => {}, finishHomeIntroduction: () => {} });
        return () => h(ChatPane, { chatId: chat.id });
      },
    }), { global: { plugins: [router], stubs: { ChatPane: false } } });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    using _printSpy = vi.spyOn(window, 'print').mockImplementation(() => {
      expect(document.title).toBe(chat.title);
    });
    const pane = wrapper.getComponent(ChatPane);
    pane.getComponent({ name: 'ChatPaneHeader' }).vm.$emit('print');
    await flushPromises();
    expect(usePrint().activePrintMode.value).toBe('chat');
    expect(document.title).toBe(chat.title);
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe('Naidan');
    usePrint().markPrintReady();
    await flushPromises();
    expect(window.print).toHaveBeenCalledOnce();
    expect(document.title).toBe('Naidan');
    expect(usePrint().activePrintMode.value).toBeUndefined();
  });
});
