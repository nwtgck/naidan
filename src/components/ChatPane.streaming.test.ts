import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatPane from './ChatPane.vue';
import { nextTick } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { useChat } from '@/composables/useChat';


import { setupScrollToMock } from '@/utils/test-utils';


// --- Mocks ---

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', defaultModelId: 'gpt-4' } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

let triggerChunk: (params: { chunk: string }) => void;
vi.mock('../services/lm/openai', () => ({
  OpenAIProvider: class {
    constructor() {}
    async chat({ onChunk }: { onChunk: (params: { chunk: string }) => void }) {
      triggerChunk = onChunk;
      return new Promise<void>(() => {});
    }
    async listModels() {
      return ['gpt-4'];
    }
  },
}));

vi.mock('../services/lm/ollama', () => ({
  OllamaProvider: class {
    constructor() {}
    async listModels() {
      return [];
    }
  },
}));

const chats = new Map<string, any>();
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn().mockImplementation(({ id, updater }) => {
      const existing = chats.get(id) || { id, root: { items: [] } };
      if (!chats.has(id)) chats.set(id, existing);
      const updated = updater({ current: existing });
      Object.assign(existing, updated);
      return Promise.resolve();
    }),
    loadChatMeta: vi.fn().mockImplementation((id) => Promise.resolve(chats.get(id))),
    updateChatContent: vi.fn().mockImplementation(({ id, updater }) => {
      const existing = chats.get(id) || { id, root: { items: [] } };
      if (!chats.has(id)) chats.set(id, existing);
      const updated = updater({ current: existing });
      Object.assign(existing, updated);
      return Promise.resolve();
    }),
    updateHierarchy: vi.fn().mockImplementation(({ updater }) => updater({ current: { items: [] } })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    loadChat: vi.fn().mockImplementation((id) => Promise.resolve(chats.get(id) || null)),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    getFile: vi.fn().mockResolvedValue(new Blob([])),
    notify: vi.fn(),
  },
}));

vi.mock('../composables/chat/ui/useChatPaneState', async () => {
  const currentChatStateModule = await import('@/composables/chat/ui/useCurrentChatState');
  return {
    useChatPaneState: () => {
      const state = currentChatStateModule.useCurrentChatState();
      return {
        chat: state.currentChat,
        chatGroup: state.currentChatGroup,
        activeMessages: state.activeMessages,
        allMessages: state.allMessages,
        resolvedSettings: state.resolvedSettings,
        inheritedSettings: state.inheritedSettings,
        chatGroups: state.chatGroups,
        TEST_ONLY: {
          // Export internal state and logic used only for testing here. Do not reference these in production logic.
        },
      };
    },
  };
});

function mountChatPane({
  global,
}: {
  global?: Record<string, unknown>;
}) {
  return mount(ChatPane, {
    props: {
      chatId: useChat().currentChat.value?.id ?? 'chat-1',
    },
    global,
  });
}

describe('ChatPane Streaming DOM Test', () => {
  const chatStore = useChat();
  beforeEach(() => {
    setupScrollToMock();
    vi.clearAllMocks();
    chats.clear();
    chatStore.TEST_ONLY.__testOnlySetCurrentChat({ chat: null });
  });

  it('should render assistant chunks in the DOM in real-time', async () => {
    const { createNewChat } = useChat();
    await createNewChat({
      groupId: undefined,
      modelId: undefined,
      systemPrompt: undefined
    });

    const wrapper = mountChatPane({
      global: {
        plugins: [router],
      },
    });

    await nextTick();

    const textarea = wrapper.find('[data-testid="chat-input"]');
    if (!textarea.exists()) {
      console.log('HTML State:', wrapper.html());
      throw new Error('Textarea not found');
    }

    await textarea.setValue('Hello');
    await textarea.trigger('keydown.enter', { ctrlKey: true });

    // Wait for sendMessage to reach generateResponse where triggerChunk is assigned
    await vi.waitUntil(() => triggerChunk !== undefined, { timeout: 2000, interval: 50 });

    if (!triggerChunk) {
      throw new Error('LLM chat was not triggered');
    }

    triggerChunk({ chunk: 'Live' });
    await nextTick();
    await nextTick();

    const html = wrapper.html();
    if (!html.includes('Live')) {
      console.log('DOM after first chunk:', html);
      const { activeMessages } = useChat();
      console.log('activeMessages state:', JSON.stringify(activeMessages.value, null, 2));
    }
    expect(wrapper.html()).toContain('Live');

    triggerChunk({ chunk: ' Update' });
    await nextTick();
    await nextTick();
    expect(wrapper.html()).toContain('Live Update');
  });
});
