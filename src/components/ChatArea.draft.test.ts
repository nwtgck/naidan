import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import ChatInput from './ChatInput.vue';
import { nextTick, ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { useChatDraft } from '../composables/useChatDraft';


// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

import type { MessageNode, Chat } from '../models/types';

// Mock dependencies
const mockSendMessage = vi.fn().mockResolvedValue(true);
const mockCurrentChat = ref<Chat | null>({
  id: '1',
  title: 'Test Chat',
  root: { items: [] } as { items: MessageNode[] },
  currentLeafId: undefined as string | undefined,
  debugEnabled: false,
  originChatId: undefined as string | undefined,
  modelId: undefined as string | undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
const mockActiveMessages = ref<MessageNode[]>([]);
const mockAvailableModels = ref<string[]>([]);
const mockResolvedSettings = ref<any>(null);
const mockInheritedSettings = ref<any>(null);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: ref(null),
    chatGroups: ref([]),
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
    forkChat: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    isImageMode: vi.fn(() => false),
    toggleImageMode: vi.fn(),
    getResolution: vi.fn(() => ({ width: 512, height: 512 })),
    getCount: vi.fn(() => 1),
    updateCount: vi.fn(),
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
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointType: 'openai', endpointUrl: 'http://localhost' }),
  }),
}));

describe('ChatArea Draft Maintenance', () => {
  let wrapper: VueWrapper<any>;
  beforeEach(() => {
    const { clearAllDrafts } = useChatDraft();
    clearAllDrafts();
    mockCurrentChat.value = {
      id: '1',
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
      sources: { modelId: 'global' }
    };
    mockInheritedSettings.value = {
      modelId: 'm1',
      sources: { modelId: 'global' }
    };
  });

  afterEach(() => {
    if (wrapper) wrapper.unmount();
  });

  it('should maintain input text independently when switching between chats', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');

    // 1. Type something in Chat 1
    await textarea.setValue('Draft for Chat 1');
    expect(textarea.element.value).toBe('Draft for Chat 1');

    // 2. Switch to Chat 2
    mockCurrentChat.value = {
      id: '2',
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
      id: '1',
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
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('Some text');

    // Manually set isMaximized
    const chatInput = wrapper.findComponent(ChatInput);
    (chatInput.vm as any).isMaximized = true;
    expect((chatInput.vm as any).isMaximized).toBe(true);

    // Switch chat
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: 'chat-new' };
    await nextTick();

    // Verify input is empty for new chat and maximized is reset
    expect(textarea.element.value).toBe('');
    expect((chatInput.vm as any).isMaximized).toBe(false);
  });

  it('should maintain attachments independently when switching chats', async () => {
    wrapper = mount(ChatArea, {
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
      blob: new Blob([''], { type: 'image/png' })
    };
    const chatInput = wrapper.findComponent(ChatInput);
    (chatInput.vm as any).attachments.push(attachment);
    expect((chatInput.vm as any).attachments.length).toBe(1);

    // 2. Switch to Chat 2
    mockCurrentChat.value = {
      id: '2',
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
      id: '1',
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
    wrapper = mount(ChatArea, {
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
      id: '2',
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
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: '1' };
    await nextTick();
    expect(textarea.element.value).toBe('');
  });

  it('should clear input text only after message is successfully sent', async () => {
    wrapper = mount(ChatArea, {
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
    wrapper = mount(ChatArea, {
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