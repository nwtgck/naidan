import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { nextTick, ref, computed, reactive } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

// --- Mocks ---

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

const mockActiveGenerations = reactive(new Map());
const mockCurrentChat = ref<any>(null);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    streaming: computed(() => mockActiveGenerations.size > 0),
    activeGenerations: mockActiveGenerations,
    generatingTitle: ref(false),
    activeMessages: computed(() => []),
    fetchingModels: ref(false),
    fetchAvailableModels: vi.fn(),
    getSiblings: vi.fn().mockReturnValue([]),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', defaultModelId: 'gpt-4' } },
  }),
}));

describe('ChatArea Concurrency Button State', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveGenerations.clear();
    mockCurrentChat.value = null;
  });

  it('should show Send button in an idle chat even if another chat is streaming', async () => {
    // 1. Setup Chat A (Streaming)
    const chatAId = 'chat-a';
    mockActiveGenerations.set(chatAId, { controller: new AbortController(), chat: { id: chatAId } });

    // 2. Setup Chat B (Idle - the current one)
    const chatBId = 'chat-b';
    mockCurrentChat.value = {
      id: chatBId,
      title: 'Chat B',
      root: { items: [] },
      updatedAt: Date.now(),
    };

    const wrapper = mount(ChatArea, {
      global: {
        plugins: [router],
        stubs: {
          MessageItem: true,
          ChatSettingsPanel: true,
          WelcomeScreen: true,
          ModelSelector: true,
        },
      },
    });

    await nextTick();

    const sendButton = wrapper.find('[data-testid="send-button"]');
    const abortButton = wrapper.find('[data-testid="abort-button"]');

    expect(abortButton.exists()).toBe(false);
    expect(sendButton.exists()).toBe(true);
  });

  it('should allow sending a message in an idle chat even if another chat is streaming', async () => {
    // 1. Setup Chat A (Streaming)
    const chatAId = 'chat-a';
    mockActiveGenerations.set(chatAId, { controller: new AbortController(), chat: { id: chatAId } });

    // 2. Setup Chat B (Idle - current)
    const chatBId = 'chat-b';
    mockCurrentChat.value = {
      id: chatBId,
      title: 'Chat B',
      root: { items: [] },
      updatedAt: Date.now(),
    };

    const mockSendMessage = vi.fn();
    // We need to return the mock in the useChat implementation
    vi.spyOn(await import('../composables/useChat'), 'useChat').mockReturnValue({
      currentChat: mockCurrentChat,
      streaming: computed(() => mockActiveGenerations.size > 0),
      activeGenerations: mockActiveGenerations,
      generatingTitle: ref(false),
      activeMessages: computed(() => []),
      fetchingModels: ref(false),
      fetchAvailableModels: vi.fn(),
      getSiblings: vi.fn().mockReturnValue([]),
      sendMessage: mockSendMessage, // The spy
    } as any);

    const wrapper = mount(ChatArea, {
      global: {
        plugins: [router],
        stubs: {
          MessageItem: true,
          ChatSettingsPanel: true,
          WelcomeScreen: true,
          ModelSelector: true,
        },
      },
    });

    await nextTick();

    const textarea = wrapper.find('[data-testid="chat-input"]');
    await textarea.setValue('Hello from Chat B');
    
    const sendButton = wrapper.find('[data-testid="send-button"]');
    expect(sendButton.exists()).toBe(true);
    
    await sendButton.trigger('click');
    
    // Expectation that will fail if bug exists
    expect(mockSendMessage).toHaveBeenCalledWith('Hello from Chat B', undefined, []);
  });
});