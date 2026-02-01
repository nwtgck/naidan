import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, VueWrapper } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { nextTick, ref } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

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
  }),
}));

import { config } from '@vue/test-utils';
config.global.stubs['HistoryManipulationModal'] = true;
config.global.stubs['ChatSettingsPanel'] = true;

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointType: 'openai', endpointUrl: 'http://localhost' }),
  }),
}));

describe('ChatArea Draft Maintenance', () => {
  let wrapper: VueWrapper<any>;

  beforeEach(() => {
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

  it('should maintain input text when switching between chats', async () => {
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
    
    // 3. Verify the text is still there
    // (This is the current behavior because ChatArea is reused and doesn't clear input)
    expect(textarea.element.value).toBe('Draft for Chat 1');
  });

  it('should reset maximized state when switching chats but maintain input', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });

    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    await textarea.setValue('Some text');
    
    // Manually set isMaximized
    wrapper.vm.isMaximized = true;
    expect(wrapper.vm.isMaximized).toBe(true);

    // Switch chat
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: 'chat-new' };
    await nextTick();

    // Verify input is maintained but maximized is reset
    expect(textarea.element.value).toBe('Some text');
    expect(wrapper.vm.isMaximized).toBe(false);
  });

  it('should maintain attachments when switching chats', async () => {
    wrapper = mount(ChatArea, {
      global: { plugins: [router] },
    });

    // Add a mock attachment
    const attachment = {
      id: 'att-1',
      originalName: 'hello.png',
      mimeType: 'image/png',
      size: 5,
      uploadedAt: Date.now(),
      status: 'memory' as const,
      blob: new Blob([''], { type: 'image/png' })
    };
    
    wrapper.vm.attachments.push(attachment);
    expect(wrapper.vm.attachments.length).toBe(1);

    // Switch chat
    mockCurrentChat.value = { ...mockCurrentChat.value!, id: 'chat-new' };
    await nextTick();

    // Verify attachments are maintained
    expect(wrapper.vm.attachments.length).toBe(1);
    expect(wrapper.vm.attachments[0].id).toBe('att-1');
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
