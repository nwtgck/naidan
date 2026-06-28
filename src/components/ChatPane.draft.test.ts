import type { ChatId, MessageId } from '@/models/ids';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import ChatPane from './ChatPane.vue';
import ChatInput from './ChatInput.vue';
import { nextTick, ref, computed } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { useChatDraft } from '@/composables/useChatDraft';


import { setupScrollToMock } from '@/utils/test-utils';
import { toChatId } from '@/models/ids';


// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

import type { MessageNode, Chat } from '@/models/types';

// Mock dependencies
const mockSendMessage = vi.fn().mockResolvedValue(true);
const mockCurrentChat = ref<Chat | null>({
  id: toChatId({ raw: '1' }),
  title: 'Test Chat',
  root: { items: [] } as { items: MessageNode[] },
  currentLeafId: undefined,
  debugEnabled: false,
  originChatId: undefined,
  modelId: undefined as string | undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
const mockActiveMessages = ref<MessageNode[]>([]);
const mockCurrentChatGroup = ref(null);
const mockChatGroups = ref<any[]>([]);
const mockAvailableModels = ref<string[]>([]);
const mockResolvedSettings = ref<any>(null);
const mockInheritedSettings = ref<any>(null);


vi.mock('@/composables/useApplicationPresentation', () => ({
  isApplicationInteractionEnabled: ({ interaction }: { interaction: string }) => interaction === 'enabled',
  useApplicationPresentation: () => ({
    applicationInteraction: {
      __v_isRef: true,
      value: 'enabled',
    },
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: mockCurrentChatGroup,
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: mockInheritedSettings,
    sendMessage: mockSendMessage,
    updateChatModel: vi.fn(),
    streaming: ref(false),
    activeGenerations: new Map(),
    activeMessages: mockActiveMessages,
    getSiblings: vi.fn().mockReturnValue([]),
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    abortChat: vi.fn(),
    availableModels: mockAvailableModels,
    fetchingModels: ref(false),
    generatingTitle: ref(false),
    fetchAvailableModels: vi.fn(),
    generateChatTitle: vi.fn(),
    abortTitleGeneration: vi.fn(),
    forkChat: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    isImageMode: vi.fn(() => false),
    toggleImageMode: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    getCount: vi.fn(() => 1),
    updateCount: vi.fn(),
    getSteps: vi.fn(() => undefined),
    updateSteps: vi.fn(),
    getSeed: vi.fn(() => 'browser_random'),
    updateSeed: vi.fn(),
    getPersistAs: vi.fn(() => 'original'),
    updatePersistAs: vi.fn(),
    updateResolution: vi.fn(),
    setImageModel: vi.fn(),
    getSelectedImageModel: vi.fn(),
    getSortedImageModels: vi.fn(() => []),
    imageModeMap: ref({}),
    imageResolutionMap: ref({}),
    imageCountMap: ref({}),
    imagePersistAsMap: ref({}),
    imageModelOverrideMap: ref({}),
    getReasoningEffort: vi.fn(),
    updateReasoningEffort: vi.fn(),
    updateChatSettings: vi.fn(),
    getLiveChat: vi.fn().mockImplementation((c) => c),
    chatFlow: computed(() => mockActiveMessages.value.map(m => ({
      type: 'message',
      node: m,
      mode: 'content',
      flow: { position: 'standalone', nesting: 'none' },
      isFirstInNode: true,
      isLastInNode: true,
      isFirstInTurn: true,
    }))),
    isThinkingActive: vi.fn(() => false),
    isWaitingResponse: vi.fn(() => false),
  }),
}));


vi.mock('../composables/chat/ui/useChatPaneState', () => ({
  useChatPaneState: () => ({
    chat: computed(() => mockCurrentChat.value),
    chatGroup: computed(() => mockCurrentChatGroup.value),
    activeMessages: computed(() => mockActiveMessages.value),
    allMessages: computed(() => mockActiveMessages.value),
    resolvedSettings: computed(() => mockResolvedSettings.value),
    inheritedSettings: computed(() => mockInheritedSettings.value),
    chatGroups: computed(() => mockChatGroups.value),
  }),
}));


function mountChatPane({
  props,
  attachTo,
  global,
}: {
  props?: {
    chatId?: ChatId,
    autoSendPrompt?: string,
    targetMessageId?: MessageId,
  },
  attachTo?: Element | string,
  global?: Record<string, unknown>,
} = {}) {
  return mount(ChatPane, {
    props: {
      chatId: props?.chatId ?? mockCurrentChat.value?.id ?? toChatId({ raw: '1' }),
      autoSendPrompt: props?.autoSendPrompt,
      targetMessageId: props?.targetMessageId,
    },
    attachTo,
    global,
  });
}

vi.mock('../composables/chat/useChatConversation', () => ({
  useChatConversation: () => ({
    sendMessage: ({
      content,
      parentId,
      attachments,
      lmParameters,
    }: {
      chatId: string,
      content: string,
      parentId: string | null | undefined,
      attachments: unknown[] | undefined,
      lmParameters: unknown,
    }) => mockSendMessage({
      content,
      parentId,
      attachments: attachments ?? [],
      chatTarget: undefined,
      lmParameters,
    }),
    regenerateMessage: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatModels', () => ({
  useChatModels: () => ({
    availableModels: mockAvailableModels,
    fetchingModels: computed(() => false),
    fetchForChat: vi.fn(),
    fetchForGlobalEndpoint: vi.fn(),
    fetchForEndpoint: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatMounts', () => ({
  useChatMounts: () => ({
    getMounts: () => computed(() => []),
    addMount: vi.fn(),
    removeMount: vi.fn(),
    updateMount: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatMetadata', () => ({
  useChatMetadata: () => ({
    reasoningEffort: () => computed(() => undefined),
    updateReasoningEffort: vi.fn(),
    updateModel: vi.fn(),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatGeneration', () => ({
  useChatGeneration: () => ({
    sendMessage: ({
      content,
      parentId,
      attachments,
      lmParameters,
    }: {
      content: string,
      parentId: string | null | undefined,
      attachments: unknown[] | undefined,
      lmParameters: unknown,
    }) => mockSendMessage({
      content,
      parentId,
      attachments: attachments ?? [],
      chatTarget: undefined,
      lmParameters,
    }),
    regenerateMessage: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../composables/chat/chat-scoped/useChatModelSelection', () => ({
  useChatModelSelection: () => ({
    availableModels: mockAvailableModels,
    fetchingModels: computed(() => false),
    fetchModels: vi.fn(),
    updateModel: vi.fn(),
  }),
}));

vi.mock('../composables/chat/useChatImageGeneration', () => ({
  useChatImageGeneration: () => ({
    availableModels: mockAvailableModels,
    isImageMode: computed(() => false),
    resolution: computed(() => ({ width: 512, height: 512 })),
    count: computed(() => 1),
    persistAs: computed(() => 'original'),
    steps: computed(() => undefined),
    seed: computed(() => 'browser_random'),
    selectedImageModel: computed(() => undefined),
    toggleImageMode: vi.fn(),
    updateResolution: vi.fn(),
    updateCount: vi.fn(),
    updatePersistAs: vi.fn(),
    updateSteps: vi.fn(),
    updateSeed: vi.fn(),
    setImageModel: vi.fn(),
    sendImageRequest: vi.fn().mockResolvedValue(true),
  }),
}));

vi.mock('../composables/chat/useChatImageProgress', () => ({
  useChatImageProgress: () => ({
    progress: computed(() => undefined),
    currentStep: computed(() => undefined),
    totalSteps: computed(() => undefined),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointType: 'openai', endpointUrl: 'http://localhost' }),
  }),
}));

describe('ChatPane Draft Maintenance', () => {
  let wrapper: VueWrapper<any>;
  beforeEach(() => {
    setupScrollToMock();
    const { clearAllDrafts } = useChatDraft();
    clearAllDrafts();
    mockCurrentChat.value = {
      id: toChatId({ raw: '1' }),
      title: 'Chat 1',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockResolvedSettings.value = {
      modelId: 'm1',
      sources: { modelId: 'global' },
    };
    mockInheritedSettings.value = {
      modelId: 'm1',
      sources: { modelId: 'global' },
    };
  });

  afterEach(() => {
    if (wrapper) wrapper.unmount();
  });

  it('should maintain input text independently when switching between chats', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');

    // 1. Type something in Chat 1
    await textarea.setValue('Draft for Chat 1');
    expect(textarea.element.value).toBe('Draft for Chat 1');

    // 2. Switch to Chat 2
    mockCurrentChat.value = {
      id: toChatId({ raw: '2' }),
      title: 'Chat 2',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await nextTick();

    // 3. Verify the text is empty for Chat 2
    expect(textarea.element.value).toBe('');

    // 4. Type something in Chat 2
    await textarea.setValue('Draft for Chat 2');
    expect(textarea.element.value).toBe('Draft for Chat 2');

    // 5. Switch back to Chat 1
    mockCurrentChat.value = {
      id: toChatId({ raw: '1' }),
      title: 'Chat 1',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await nextTick();

    // 6. Verify Chat 1's draft is restored
    expect(textarea.element.value).toBe('Draft for Chat 1');
  });

  it('should reset maximized state when switching chats and load respective draft', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('Some text');

    // Manually set isMaximized
    const chatInput = wrapper.findComponent(ChatInput);
    (chatInput.vm as any).isMaximized = true;
    expect((chatInput.vm as any).isMaximized).toBe(true);

    // Switch chat
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: toChatId({ raw: 'chat-new' }) };
    await nextTick();

    // Verify input is empty for new chat and maximized is reset
    expect(textarea.element.value).toBe('');
    expect((chatInput.vm as any).isMaximized).toBe(false);
  });

  it('should maintain attachments independently when switching chats', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    // 1. Add a mock attachment to Chat 1
    const attachment = {
      id: 'att-1',
      originalName: 'hello.png',
      mimeType: 'image/png',
      size: 5,
      uploadedAt: Date.now(),
      status: 'memory' as const,
      blob: new Blob([''], { type: 'image/png' }),
    };
    const chatInput = wrapper.findComponent(ChatInput);
    (chatInput.vm as any).attachments.push(attachment);
    expect((chatInput.vm as any).attachments.length).toBe(1);

    // 2. Switch to Chat 2
    mockCurrentChat.value = {
      id: toChatId({ raw: '2' }),
      title: 'Chat 2',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await nextTick();

    // 3. Verify attachments are empty for Chat 2
    expect((chatInput.vm as any).attachments.length).toBe(0);

    // 4. Switch back to Chat 1
    mockCurrentChat.value = {
      id: toChatId({ raw: '1' }),
      title: 'Chat 1',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await nextTick();

    // 5. Verify Chat 1's attachment is restored
    expect((chatInput.vm as any).attachments.length).toBe(1);
    expect((chatInput.vm as any).attachments[0].id).toBe('att-1');
  });

  it('should NOT clear the input of the NEW chat if a message from the PREVIOUS chat finishes sending', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');

    // 1. Start sending in Chat 1 but don't finish yet (Pending Promise)
    let resolveSendMessage: (val: boolean) => void;
    mockSendMessage.mockReturnValueOnce(new Promise(resolve => {
      resolveSendMessage = resolve;
    }));

    await textarea.setValue('Message for Chat 1');
    const chatInput = wrapper.findComponent(ChatInput);
    const sendPromise = (chatInput.vm as any).handleSend(); // Start sending

    // 2. Switch to Chat 2 while sending is in progress
    mockCurrentChat.value = {
      id: toChatId({ raw: '2' }),
      title: 'Chat 2',
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false,
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await nextTick();

    // 3. Start writing something new in Chat 2
    await textarea.setValue('Writing something for Chat 2');
    expect(textarea.element.value).toBe('Writing something for Chat 2');

    // 4. Chat 1's sending completes now
    resolveSendMessage!(true);
    await sendPromise;
    await nextTick();

    // 5. Verification: Chat 2's input should NOT be cleared
    expect(textarea.element.value).toBe('Writing something for Chat 2');

    // 6. Verification: Chat 1's draft should be cleared (switch back to check)
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: toChatId({ raw: '1' }) };
    await nextTick();
    expect(textarea.element.value).toBe('');
  });

  it('should clear input text only after message is successfully sent', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('Message to send');

    // Mock sendMessage to succeed
    mockSendMessage.mockResolvedValueOnce(true);

    const sendBtn = wrapper.find('[data-testid="send-button"]');
    await sendBtn.trigger('click');

    await nextTick();
    await nextTick(); // Wait for success block to execute

    expect(textarea.element.value).toBe('');
  });

  it('should NOT clear input text if message sending fails', async () => {
    wrapper = mountChatPane( {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('Important draft');

    // Mock sendMessage to fail
    mockSendMessage.mockResolvedValueOnce(false);

    const sendBtn = wrapper.find('[data-testid="send-button"]');
    await sendBtn.trigger('click');

    await nextTick();
    await nextTick();

    expect(textarea.element.value).toBe('Important draft');
  });
});
