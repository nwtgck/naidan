import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { storageService } from '../services/storage';
import { reactive, nextTick } from 'vue';
import type { Chat, ChatGroup, SidebarItem } from '../models/types';

// Mock storage
const mockRootItems: SidebarItem[] = [];

vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    listChats: vi.fn().mockResolvedValue([]),
    loadChat: vi.fn(),
    saveChat: vi.fn(),
    saveChatMeta: vi.fn(),
    saveChatContent: vi.fn(),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    deleteChat: vi.fn(),
    updateChatGroup: vi.fn(),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getSidebarStructure: vi.fn().mockImplementation(() => Promise.resolve([...mockRootItems])),
    deleteChatGroup: vi.fn(),
  },
}));

vi.mock('./useSettings', () => ({
  useSettings: () => ({
    settings: {
      value: {
        endpointType: 'openai',
        endpointUrl: 'http://global-url',
        defaultModelId: 'global-model',
        systemPrompt: 'Global Prompt',
        lmParameters: { temperature: 0.7 },
      }
    },
    isOnboardingDismissed: { value: true },
    onboardingDraft: { value: null },
  }),
}));

const mockLlmChat = vi.fn();
vi.mock('../services/llm', () => ({
  OpenAIProvider: function() {
    return {
      chat: mockLlmChat,
      listModels: vi.fn().mockResolvedValue(['model-1', 'chat-model', 'group-model', 'group-special-model', 'global-model']),
    };
  },
  OllamaProvider: function() {
    return {
      chat: mockLlmChat,
      listModels: vi.fn().mockResolvedValue(['model-1', 'chat-model', 'group-model', 'group-special-model', 'global-model']),
    };
  },
}));

describe('useChat Group Overrides Resolution', () => {
  const chatStore = useChat();

  beforeEach(() => {
    vi.clearAllMocks();
    chatStore.rootItems.value = [];
    mockRootItems.length = 0;
  });

  it('resolves settings with Chat > Group > Global priority', async () => {
    const group: ChatGroup = {
      id: 'g1',
      name: 'Group 1',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      modelId: 'group-model',
      systemPrompt: { content: 'Group Prompt', behavior: 'override' },
      lmParameters: { temperature: 0.5 },
    };

    const chat: Chat = reactive({
      id: 'c1',
      title: 'Chat 1',
      groupId: 'g1',
      root: { items: [{ id: 'm1', role: 'assistant', content: '', replies: { items: [] }, timestamp: 0 }] },
      modelId: 'chat-model',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
      systemPrompt: { content: 'Chat Prompt', behavior: 'append' },
    });

    chatStore.rootItems.value = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group }];
    mockRootItems.push(...chatStore.rootItems.value);

    // Testing sendMessage resolution
    await chatStore.sendMessage('Hello', null, [], chat);

    // Verify the LLM was called with resolved settings
    // Resolved System Prompt: ["Group Prompt", "Chat Prompt"]
    
    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: 'Group Prompt' }),
        expect.objectContaining({ role: 'system', content: 'Chat Prompt' })
      ]),
      'chat-model', // Chat override takes precedence
      'http://global-url', // Inherited from Global
      expect.any(Function),
      expect.objectContaining({ temperature: 0.5 }), // Chat (none) < Group (0.5) < Global (0.7)
      undefined,
      expect.any(AbortSignal)
    );
  });

  it('resolves system prompt with nested overrides/appends correctly', async () => {
    const group: ChatGroup = {
      id: 'g1',
      name: 'Group 1',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      systemPrompt: { content: 'Group Instruction', behavior: 'append' },
    };

    const chat: Chat = reactive({
      id: 'c1',
      title: 'Chat 1',
      groupId: 'g1',
      root: { items: [{ id: 'm1', role: 'assistant', content: '', replies: { items: [] }, timestamp: 0 }] },
      modelId: 'base-model',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    chatStore.rootItems.value = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group }];
    mockRootItems.push(...chatStore.rootItems.value);

    await chatStore.sendMessage('Hello', null, [], chat);

    // Global: "Global Prompt"
    // Group: Append "Group Instruction" -> ["Global Prompt", "Group Instruction"]
    // Chat: None -> Inherit from resolved Group
    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: 'Global Prompt' }),
        expect.objectContaining({ role: 'system', content: 'Group Instruction' })
      ]),
      expect.any(String),
      expect.any(String),
      expect.any(Function),
      expect.any(Object),
      undefined,
      expect.any(AbortSignal)
    );
  });

  it('uses Group modelId if Chat override is missing', async () => {
    const group: ChatGroup = {
      id: 'g1',
      name: 'G',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      modelId: 'group-special-model',
    };

    const chat: Chat = reactive({
      id: 'c1',
      title: 'Chat 1',
      groupId: 'g1',
      root: { items: [{ id: 'm1', role: 'assistant', content: '', replies: { items: [] }, timestamp: 0 }] },
      modelId: '',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    chatStore.rootItems.value = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group }];
    mockRootItems.push(...chatStore.rootItems.value);

    await chatStore.sendMessage('Hello', null, [], chat);

    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.any(Array),
      'group-special-model',
      expect.any(String),
      expect.any(Function),
      expect.any(Object),
      undefined,
      expect.any(AbortSignal)
    );
  });

  it('clears currentChatGroup when opening a chat or creating a new one', async () => {
    chatStore.currentChatGroup.value = { id: 'g1', name: 'G1', items: [], updatedAt: 0, isCollapsed: false };
    
    vi.mocked(storageService.loadChat).mockResolvedValue({ id: 'c1', title: 'C1' } as any);
    await chatStore.openChat('c1');
    expect(chatStore.currentChatGroup.value).toBeNull();

    chatStore.currentChatGroup.value = { id: 'g1', name: 'G1', items: [], updatedAt: 0, isCollapsed: false };
    await chatStore.createNewChat();
    expect(chatStore.currentChatGroup.value).toBeNull();
  });

  it('inherits endpoint URL and headers from Group if Chat overrides are missing', async () => {
    const group: ChatGroup = {
      id: 'g1',
      name: 'G',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      endpoint: {
        type: 'ollama',
        url: 'http://group-ollama:11434',
        httpHeaders: [['X-Group-Header', 'group-val']],
      },
    };

    const chat: Chat = reactive({
      id: 'c1',
      title: 'Chat 1',
      groupId: 'g1',
      root: { items: [{ id: 'm1', role: 'assistant', content: '', replies: { items: [] }, timestamp: 0 }] },
      modelId: 'some-model',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    chatStore.rootItems.value = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group }];
    mockRootItems.push(...chatStore.rootItems.value);

    await chatStore.sendMessage('Hello', null, [], chat);

    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      'http://group-ollama:11434', // Inherited from Group
      expect.any(Function),
      expect.any(Object),
      [['X-Group-Header', 'group-val']], // Inherited from Group
      expect.any(AbortSignal)
    );
  });

  it('merges LM parameters across all 3 levels (Chat > Group > Global)', async () => {
    // Global: temperature: 0.7
    const group: ChatGroup = {
      id: 'g1', name: 'G', items: [], updatedAt: 0, isCollapsed: false,
      lmParameters: { topP: 0.5, temperature: 0.9 }, // Overrides Global temp
    };
    const chat: Chat = reactive({
      id: 'c1',
      title: 'Chat 1',
      groupId: 'g1',
      root: { items: [{ id: 'm1', role: 'assistant', content: '', replies: { items: [] }, timestamp: 0 }] },
      modelId: 'm1',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
      lmParameters: { maxCompletionTokens: 100, temperature: 0.1 }, // Overrides Group temp
    });

    chatStore.rootItems.value = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group }];
    mockRootItems.push(...chatStore.rootItems.value);

    await chatStore.sendMessage('Hi', null, [], chat);

    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      expect.any(String),
      expect.any(Function),
      {
        temperature: 0.1,         // Chat wins
        topP: 0.5,                // Group wins (not in chat)
        maxCompletionTokens: 100, // Chat wins
      },
      undefined,
      expect.any(AbortSignal)
    );
  });

  it('suppresses Global prompt when Group uses override behavior with empty content', async () => {
    const group: ChatGroup = {
      id: 'g1', name: 'G', items: [], updatedAt: 0, isCollapsed: false,
      systemPrompt: { content: '', behavior: 'override' },
    };
    const chat: Chat = reactive({
      id: 'c1',
      title: 'Chat 1',
      groupId: 'g1',
      root: { items: [{ id: 'm1', role: 'assistant', content: '', replies: { items: [] }, timestamp: 0 }] },
      modelId: 'm1',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    chatStore.rootItems.value = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group }];
    mockRootItems.push(...chatStore.rootItems.value);

    await chatStore.sendMessage('Hi', null, [], chat);

    const messages = mockLlmChat.mock.calls[0]![0];
    // Global "Global Prompt" should be gone. Only User message left.
    expect(messages.filter((m: any) => m.role === 'system')).toHaveLength(0);
  });

  it('updates resolved settings dynamically when chat is moved to a group', async () => {
    const group: ChatGroup = {
      id: 'g1', name: 'G', items: [], updatedAt: 0, isCollapsed: false,
      modelId: 'group-model',
    };
    const chat: Chat = reactive({
      id: 'c1',
      title: 'Chat 1',
      groupId: null, // Initially no group
      root: { items: [{ id: 'm1', role: 'assistant', content: '', replies: { items: [] }, timestamp: 0 }] },
      modelId: '', createdAt: 0, updatedAt: 0, debugEnabled: false,
    });

    chatStore.rootItems.value = [
      { id: 'chat_group:g1', type: 'chat_group', chatGroup: group },
      { id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C', updatedAt: 0 } }
    ];
    mockRootItems.push(...chatStore.rootItems.value);

    // 1. Send message while Chat is NOT in group
    await chatStore.sendMessage('Hi', null, [], chat);
    expect(mockLlmChat).toHaveBeenLastCalledWith(
      expect.any(Array),
      'global-model', // Uses global
      expect.any(String), expect.any(Function), expect.any(Object), undefined, expect.any(AbortSignal)
    );

    // 2. Move chat to group
    chat.groupId = 'g1';
    await nextTick();
    
    await chatStore.sendMessage('Hi again', null, [], chat);
    
    expect(mockLlmChat).toHaveBeenLastCalledWith(
      expect.any(Array),
      'group-model', // Now uses group override
      expect.any(String), expect.any(Function), expect.any(Object), undefined, expect.any(AbortSignal)
    );
  });

  it('inherits endpoint URL and headers from Group if Chat overrides are missing', async () => {
    const group: ChatGroup = {
      id: 'g1',
      name: 'G',
      items: [],
      updatedAt: 0,
      isCollapsed: false,
      endpoint: {
        type: 'ollama',
        url: 'http://group-ollama:11434',
        httpHeaders: [['X-Group-Header', 'group-val']],
      },
    };

    const chat: Chat = reactive({
      id: 'c1',
      title: 'Chat 1',
      groupId: 'g1',
      root: { items: [{ id: 'm1', role: 'assistant', content: '', replies: { items: [] }, timestamp: 0 }] },
      modelId: 'some-model',
      createdAt: 0,
      updatedAt: 0,
      debugEnabled: false,
    });

    chatStore.rootItems.value = [{ id: 'chat_group:g1', type: 'chat_group', chatGroup: group }];
    mockRootItems.push(...chatStore.rootItems.value);

    await chatStore.sendMessage('Hello', null, [], chat);

    expect(mockLlmChat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(String),
      'http://group-ollama:11434', // Inherited from Group
      expect.any(Function),
      expect.any(Object),
      [['X-Group-Header', 'group-val']], // Inherited from Group
      expect.any(AbortSignal)
    );
  });
});