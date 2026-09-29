import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, effectScope, nextTick, ref, watch } from 'vue';
import type { Chat, ChatContent, ChatMeta } from '@/01-models/types';
import { toChatId } from '@/01-models/ids';
import { STORAGE_KEY_PREFIX } from '@/constants';
import { LocalStorageProvider } from '@/00-storage/service/local-storage';
import { createChatDataStore } from '@/composables/chat/global/chat-data-store';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ChatPage from './[id].vue';

const { mockLoadChat, mockSetCurrentChatId, mockUpdateContent, mockUpdateMeta, mockSend } = vi.hoisted(() => ({
  mockLoadChat: vi.fn(),
  mockSetCurrentChatId: vi.fn(),
  mockUpdateContent: vi.fn(),
  mockUpdateMeta: vi.fn(),
  mockSend: vi.fn(),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    loadChat: mockLoadChat,
    updateChatContent: mockUpdateContent,
    updateChatMeta: mockUpdateMeta,
    subscribeToChanges: vi.fn(() => () => undefined),
  },
}));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: ref({}) }) }));
vi.mock('@/features/tools/composables/useChatTools', () => ({
  useChatTools: () => ({ setCurrentChatId: mockSetCurrentChatId, setToolEnabled: vi.fn() }),
}));
vi.mock('@/composables/chat/chat-derived-state', () => ({
  createChatDerivedState: () => ({ hasMountsForChat: () => false }),
}));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  get chatDataStore() {
    return store;
  },
  get currentChatRef() {
    return store.currentChatRef;
  },
  get rootItems() {
    return store.rootItems;
  },
}));
vi.mock('@/composables/chat/ui/useCurrentChatState', () => ({
  useCurrentChatState: () => ({ currentChatId: computed(() => store.currentChatRef.value?.id) }),
}));
vi.mock('vue-router', () => ({ useRouter: () => router }));
vi.mock('@/components/UnselectedChatPane.vue', () => ({
  default: { template: '<div data-testid="unselected-chat"></div>' },
}));
vi.mock('@/components/ChatPane.vue', () => ({
  default: defineComponent({
    props: { chatId: String, autoSendPrompt: String },
    emits: ['auto-sent'],
    setup(props, { emit }) {
      const draft = ref('');
      watch(() => props.autoSendPrompt, async () => {
        await nextTick();
        if (!props.autoSendPrompt) return;
        mockSend({ chatId: props.chatId, content: props.autoSendPrompt });
        emit('auto-sent');
      }, { immediate: true });
      return { draft };
    },
    template: '<textarea data-testid="live-draft" v-model="draft" />',
  }),
}));

let store: ReturnType<typeof createChatDataStore>;
let scope: ReturnType<typeof effectScope>;
let wrapper: VueWrapper | undefined;
let provider: LocalStorageProvider;
const route = ref<{ params: { id: string }, query: Record<string, string> }>({ params: { id: 'a' }, query: {} });
const router = {
  currentRoute: route,
  replace: vi.fn(({ query }: { query: Record<string, string> }) => {
    route.value = { ...route.value, query };
  }),
};

function recordKey({ id, kind }: { id: string, kind: 'meta' | 'content' }) {
  return `${STORAGE_KEY_PREFIX}lsp:chat_${kind}:${id}`;
}

function saveRecord({ id, content }: { id: string, content: string }) {
  localStorage.setItem(recordKey({ id, kind: 'meta' }), JSON.stringify({ id, title: id, createdAt: 0, updatedAt: 1, debugEnabled: false }));
  localStorage.setItem(recordKey({ id, kind: 'content' }), content);
}

const validContent = JSON.stringify({ root: { items: [] } });
const invalidContent = JSON.stringify({ root: { items: [{ id: 'future', role: 'assistant', createdAt: 0,
  parts: [{ id: 'p', type: 'future_part', text: 'Preserve the original record' }], replies: { items: [] } }] } });

function deferredChat() {
  let resolve!: (chat: Chat | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Chat | null>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
  localStorage.clear();
  provider = new LocalStorageProvider();
  mockLoadChat.mockImplementation(({ id }: { id: Chat['id'] }) => provider.loadChat({ id }));
  mockUpdateContent.mockImplementation(async ({ id, updater }: {
    id: Chat['id'], updater: ({ current }: { current: ChatContent | null }) => ChatContent | Promise<ChatContent>,
  }) => provider.saveChatContent({ id, content: await updater({ current: await provider.loadChatContent({ id }) }) }));
  mockUpdateMeta.mockImplementation(async ({ id, updater }: {
    id: Chat['id'], updater: ({ current }: { current: ChatMeta | null }) => ChatMeta | Promise<ChatMeta>,
  }) => provider.saveChatMeta({ meta: await updater({ current: await provider.loadChatMeta({ id }) }) }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  scope = effectScope();
  store = scope.run(() => createChatDataStore({
    pruneVolatileAssistantErrorsForChat: vi.fn(),
    hasActiveGeneration: () => false,
    isTaskRunning: () => false,
    onExternalGenerationStarted: vi.fn(),
    onExternalGenerationStopped: vi.fn(),
    onExternalGenerationAbortRequest: vi.fn(),
    onMigration: vi.fn(),
  }))!;
  route.value = { params: { id: 'a' }, query: {} };
  saveRecord({ id: 'a', content: validContent });
  saveRecord({ id: 'b', content: invalidContent });
  wrapper = mount(ChatPage, { attachTo: document.body });
  await flushPromises();
});

afterEach(() => {
  wrapper?.unmount();
  scope.stop();
  vi.restoreAllMocks();
});

describe('chat route read failures', () => {
  it.each<Record<string, string>>([{}, { 'message-id': 'future' }])('isolates a rejected read with query %j and retries without changing the previous draft or saved records', async (query) => {
    const page = wrapper!;
    const input = page.get('[data-testid="live-draft"]');
    await input.setValue('Unsaved A draft');
    const liveA = store.currentChatRef.value!;
    const rootA = liveA.root;
    const savedA = localStorage.getItem(recordKey({ id: 'a', kind: 'content' }));
    const savedBMeta = localStorage.getItem(recordKey({ id: 'b', kind: 'meta' }));
    mockSetCurrentChatId.mockClear();

    route.value = { params: { id: 'b' }, query: { ...query, q: 'Only send to B' } };
    await flushPromises();

    expect(page.get('[data-testid="chat-load-error"]').text()).toContain('Could not load this chat');
    expect(page.get('[data-testid="chat-page-content"]').attributes('inert')).toBeDefined();
    expect(page.get('[data-testid="chat-page-content"]').isVisible()).toBe(false);
    expect(page.get('[data-testid="live-draft"]').element).toBe(input.element);
    expect((input.element as HTMLTextAreaElement).value).toBe('Unsaved A draft');
    expect(store.currentChatRef.value).toBe(liveA);
    expect(store.getLiveChatById({ chatId: toChatId({ raw: 'a' }) })).toBe(liveA);
    expect(liveA.root).toBe(rootA);
    expect(mockSetCurrentChatId).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockUpdateContent).not.toHaveBeenCalled();
    expect(mockUpdateMeta).not.toHaveBeenCalled();
    expect(localStorage.getItem(recordKey({ id: 'a', kind: 'content' }))).toBe(savedA);
    expect(localStorage.getItem(recordKey({ id: 'b', kind: 'content' }))).toBe(invalidContent);
    expect(localStorage.getItem(recordKey({ id: 'b', kind: 'meta' }))).toBe(savedBMeta);

    localStorage.setItem(recordKey({ id: 'b', kind: 'content' }), validContent);
    await page.get('[data-testid="chat-load-retry"]').trigger('click');
    await flushPromises();

    expect(page.find('[data-testid="chat-load-error"]').exists()).toBe(false);
    expect(page.get('[data-testid="chat-page-content"]').isVisible()).toBe(true);
    expect(store.currentChatRef.value?.id).toBe('b');
    expect(mockSetCurrentChatId).toHaveBeenCalledExactlyOnceWith({ chatId: 'b' });
    expect(mockSend).toHaveBeenCalledExactlyOnceWith({ chatId: 'b', content: 'Only send to B' });
    expect(route.value.query.q).toBeUndefined();
    expect(mockUpdateContent).not.toHaveBeenCalled();
    expect(mockUpdateMeta).not.toHaveBeenCalled();
  });

  it('keeps a missing chat distinct from an unreadable chat', async () => {
    route.value = { params: { id: 'missing' }, query: { q: 'Do not send anywhere else' } };
    await flushPromises();
    expect(store.currentChatRef.value).toBeNull();
    expect(wrapper!.find('[data-testid="unselected-chat"]').exists()).toBe(true);
    expect(wrapper!.find('[data-testid="chat-load-error"]').exists()).toBe(false);
    expect(mockSetCurrentChatId).toHaveBeenLastCalledWith({ chatId: null });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('ignores a late read failure after navigating back to the live chat', async () => {
    const pending = deferredChat();
    mockLoadChat.mockReturnValueOnce(pending.promise);
    route.value = { params: { id: 'b' }, query: { q: 'Only send to B' } };
    await nextTick();
    expect(wrapper!.get('[data-testid="chat-page-content"]').isVisible()).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();

    route.value = { params: { id: 'a' }, query: {} };
    await flushPromises();
    pending.reject(new Error('Failed earlier read'));
    await flushPromises();

    expect(wrapper!.get('[data-testid="chat-page-content"]').isVisible()).toBe(true);
    expect(wrapper!.find('[data-testid="chat-load-error"]').exists()).toBe(false);
    expect(store.currentChatRef.value?.id).toBe('a');
    expect(mockSetCurrentChatId).toHaveBeenLastCalledWith({ chatId: 'a' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
