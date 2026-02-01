import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import ChatArea from './ChatArea.vue';
import { nextTick, ref, reactive } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';

// Mock router
const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: {} }],
});

import type { MessageNode, Chat } from '../models/types';

// Mock dependencies
const mockSendMessage = vi.fn().mockResolvedValue(true);
const mockFetchAvailableModels = vi.fn().mockResolvedValue(['model-1']);
const mockStreaming = ref(false);
const mockIsTaskRunningValue = ref(false);
const mockAvailableModels = ref<string[]>([]);
const mockFetchingModels = ref(false);
const mockCurrentChat = ref<Chat | null>(null);
const mockActiveMessages = ref<MessageNode[]>([]);
const mockChatGroups = ref<any[]>([]);
const mockResolvedSettings = ref<any>(null);
const mockInheritedSettings = ref<any>(null);

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: mockCurrentChat,
    currentChatGroup: ref(null),
    chatGroups: mockChatGroups,
    resolvedSettings: mockResolvedSettings,
    inheritedSettings: mockInheritedSettings,
    sendMessage: mockSendMessage,
    updateChatModel: vi.fn(),
    saveChat: vi.fn(),
    streaming: mockStreaming,
    activeGenerations: reactive(new Map()),
    toggleDebug: vi.fn(),
    activeMessages: mockActiveMessages,
    getSiblings: vi.fn().mockReturnValue([]),
    editMessage: vi.fn(),
    switchVersion: vi.fn(),
    abortChat: vi.fn(),
    availableModels: mockAvailableModels,
    fetchingModels: mockFetchingModels,
    generatingTitle: ref(false),
    fetchAvailableModels: mockFetchAvailableModels,
    generateChatTitle: vi.fn(),
    forkChat: vi.fn().mockResolvedValue('new-id'),
    openChatGroup: vi.fn(),
    moveChatToGroup: vi.fn(),
    isTaskRunning: vi.fn((_id: string) => mockIsTaskRunningValue.value || mockStreaming.value),
    isProcessing: vi.fn((_id: string) => mockStreaming.value),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointType: 'openai', endpointUrl: 'http://localhost', defaultModelId: 'global-default-model' }),
    availableModels: mockAvailableModels,
    isFetchingModels: mockFetchingModels,
    fetchModels: mockFetchAvailableModels,
  }),
}));

// Mock Mermaid
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}));

import { config } from '@vue/test-utils';
config.global.stubs['HistoryManipulationModal'] = true;
config.global.stubs['ChatSettingsPanel'] = true;

describe('ChatArea Auto-send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCurrentChat.value = {
      id: '1', 
      title: 'Test Chat', 
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false, 
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    mockResolvedSettings.value = {
      modelId: 'model-1',
      sources: { modelId: 'global' }
    };
    mockSendMessage.mockResolvedValue(true);
  });

  it('should wait for currentChat to be available before auto-sending', async () => {
    mockCurrentChat.value = null;
    
    const wrapper = mount(ChatArea, {
      props: {
        autoSendPrompt: 'hello'
      },
      global: { plugins: [router] },
    });

    expect(mockSendMessage).not.toHaveBeenCalled();

    // Now set currentChat
    mockCurrentChat.value = {
      id: '1', 
      title: 'Test Chat', 
      root: { items: [] },
      currentLeafId: undefined,
      debugEnabled: false, 
      originChatId: undefined,
      modelId: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockSendMessage).toHaveBeenCalledWith('hello', undefined, []);
    expect(wrapper.emitted('auto-sent')).toBeTruthy();
  });

  it('should not clear input if sendMessage fails', async () => {
    mockSendMessage.mockResolvedValue(false);
    
    const wrapper = mount(ChatArea, {
      props: {
        autoSendPrompt: 'hello'
      },
      global: { plugins: [router] },
    });

    await flushPromises();
    await nextTick();
    await nextTick();

    expect(mockSendMessage).toHaveBeenCalled();
    const textarea = wrapper.find<HTMLTextAreaElement>('[data-testid="chat-input"]');
    expect(textarea.element.value).toBe('hello');
    expect(wrapper.emitted('auto-sent')).toBeTruthy(); // It still emits auto-sent because it tried
  });

  it('should NOT return early in handleSend if only fetching models', async () => {
    // Simulate fetching models
    mockIsTaskRunningValue.value = true;
    
    mount(ChatArea, {
      props: {
        autoSendPrompt: 'hello'
      },
      global: { plugins: [router] },
    });

    await flushPromises();
    await nextTick();
    await nextTick();

    // If it returns early, mockSendMessage won't be called
    expect(mockSendMessage).toHaveBeenCalledWith('hello', undefined, []);
  });
});
