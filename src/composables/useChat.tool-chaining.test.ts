import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive, nextTick } from 'vue';
import type { Chat, SidebarItem, Hierarchy } from '../models/types';
import { useGlobalEvents } from './useGlobalEvents';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];
let mockHierarchy: Hierarchy = { items: [] };

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn(),
    updateHierarchy: vi.fn(),
    loadHierarchy: vi.fn(),
    deleteChat: vi.fn(),
    updateChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    deleteChatGroup: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    notify: vi.fn(),
    getFile: vi.fn().mockResolvedValue(null),
    saveFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock settings
vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', endpointUrl: 'http://localhost', storageType: 'local', autoTitleEnabled: true, defaultModelId: 'gpt-4' } },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
    setHeavyContentAlertDismissed: vi.fn(),
    setOnboardingDraft: vi.fn(),
    setIsOnboardingDismissed: vi.fn(),
  }),
}));

// Mock Confirm
vi.mock('./useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: vi.fn().mockResolvedValue(true),
  }),
}));

// Mock LLM Provider
const mockLlmChat = vi.fn();

vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: function() {
      return {
        chat: mockLlmChat,
        listModels: vi.fn().mockResolvedValue(['gpt-4']),
      };
    },
    OllamaProvider: function() {
      return {
        chat: vi.fn(),
        listModels: vi.fn().mockResolvedValue(['gpt-4']),
      };
    },
    TransformersJsProvider: vi.fn(),
  };
});

// Mock Tools Registry
vi.mock('../services/tools/registry', () => ({
  ALL_TOOLS: [
    {
      name: 'calculator',
      description: 'Calculator',
      parametersSchema: { strict: () => ({ parse: (args: any) => args }) },
      execute: vi.fn().mockResolvedValue({ status: 'success', content: '42' }),
    }
  ],
}));

vi.mock('./useChatTools', () => ({
  useChatTools: () => ({
    enabledToolNames: { value: ['calculator'] },
  }),
}));


describe('useChat Tool Chaining', () => {
  const chatStore = useChat();
  const {
    activeMessages, sendMessage, __testOnly
  } = chatStore;
  const { __testOnlySetCurrentChat } = __testOnly;

  const { clearEvents } = useGlobalEvents();

  beforeEach(() => {
    vi.clearAllMocks();
    __testOnlySetCurrentChat(null);
    chatStore.rootItems.value = [];
    mockRootItems.length = 0;
    mockHierarchy = { items: [] };
    clearEvents();

    // Setup persistence mocks
    vi.mocked(storageService.updateChatMeta).mockResolvedValue(undefined);
    vi.mocked(storageService.updateChatContent).mockImplementation((_id, updater) => {
      return Promise.resolve(updater({ root: { items: [] }, currentLeafId: undefined })) as any;
    });
    vi.mocked(storageService.loadHierarchy).mockImplementation(() => Promise.resolve(mockHierarchy));
  });

  it('should chain multiple tool calls in the active thread', async () => {
    const chat: Chat = reactive({
      id: 'chat-1',
      title: 'Tool Test',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: true,
      endpointType: 'openai',
      endpointUrl: 'http://localhost',
      modelId: 'gpt-4',
    });
    __testOnlySetCurrentChat(chat);

    // Mock LLM to return two tool calls
    mockLlmChat.mockImplementation(async (params) => {
      const { onToolCall, onToolResult, onChunk, onAssistantMessageStart } = params;

      // Iteration 1: Assistant makes tool calls
      onAssistantMessageStart?.();
      onToolCall({ id: 'call-1', toolName: 'calculator', args: { expression: '1+1' } });
      await nextTick();
      await onToolResult({ id: 'call-1', result: { status: 'success', content: '2' } });
      await nextTick();

      onToolCall({ id: 'call-2', toolName: 'calculator', args: { expression: '2+2' } });
      await nextTick();
      await onToolResult({ id: 'call-2', result: { status: 'success', content: '4' } });
      await nextTick();

      // Iteration 2: Assistant responds with final text
      onAssistantMessageStart?.();
      onChunk('Final answer is 4.');
      await nextTick();
    });

    await sendMessage('Calculate 1+1 and 2+2');

    // Wait for async generation to complete
    for (let i = 0; i < 20; i++) {
      await flushPromises();
      await nextTick();
      await new Promise(r => setTimeout(r, 50));
      if (activeMessages.value.length >= 4) break;
    }

    const messages = activeMessages.value;
    console.log('Active messages roles:', messages.map(m => m.role));
    if (messages.length < 4) {
      console.log('Chat structure:', JSON.stringify(chat.root, (key, value) => key === 'replies' ? { itemsCount: value.items.length } : value, 2));
    }

    const { activeDisplayMessages } = chatStore;
    const displayMessages = activeDisplayMessages.value;
    console.log('Display messages types:', displayMessages.map(d => d.type));

    // New structure: user, assistant1 (calls), tool (consolidated), assistant2 (final)
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    expect(displayMessages.map(d => d.type)).toEqual(['message', 'message', 'tool_group', 'message']);

    const toolGroup = displayMessages[2] as { type: 'tool_group', toolCalls: any[] };
    expect(toolGroup.toolCalls).toHaveLength(2);
    expect(toolGroup.toolCalls[0].id).toBe('call-1');
    expect(toolGroup.toolCalls[1].id).toBe('call-2');

    // Check tree structure
    const assistant1 = messages[1]!;
    const toolNode = messages[2]!;
    const assistant2 = messages[3]!;

    expect(assistant1.replies.items).toContain(toolNode);
    expect(toolNode.replies.items).toContain(assistant2);
  });

  it('should correctly follow the branch even with multiple root items', async () => {
    const chat: Chat = reactive({
      id: 'chat-2',
      title: 'Branch Test',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: true,
      endpointType: 'openai',
      endpointUrl: 'http://localhost',
      modelId: 'gpt-4',
    });
    __testOnlySetCurrentChat(chat);

    // Add first root item
    await sendMessage('Message 1');
    await flushPromises();
    await nextTick();

    // Add second root item (new thread)
    await sendMessage('Message 2', null);
    await flushPromises();
    await nextTick();

    expect(chat.root.items).toHaveLength(2);

    // Last leaf should be in the second thread
    const messages = activeMessages.value;
    expect(messages[0]!.content).toBe('Message 2');
  });
});

