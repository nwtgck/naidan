import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChat } from './useChat';
import { useSettings } from './useSettings';
import { reactive, nextTick } from 'vue';
import { storageService } from '../services/storage';

// Mock storage
vi.mock('../services/storage', () => ({
  storageService: {
    init: vi.fn(),
    subscribeToChanges: vi.fn().mockReturnValue(() => {}),
    saveChat: vi.fn().mockResolvedValue(undefined),
    updateChatMeta: vi.fn(), loadChatMeta: vi.fn(),
    updateChatContent: vi.fn().mockImplementation((_id, updater) => Promise.resolve(updater(null))),
    updateHierarchy: vi.fn().mockImplementation((updater) => updater({ items: [] })),
    loadHierarchy: vi.fn().mockResolvedValue({ items: [] }),
    loadChat: vi.fn(),
    loadSettings: vi.fn().mockResolvedValue({}),
    getSidebarStructure: vi.fn().mockResolvedValue([]),
    updateSettings: vi.fn(),
    listChats: vi.fn().mockResolvedValue([]),
    listChatGroups: vi.fn().mockResolvedValue([]),
    getCurrentType: vi.fn().mockReturnValue('local'),
    notify: vi.fn(),
  },
}));

const mockOpenAIChat = vi.fn();

vi.mock('../services/llm', () => {
  return {
    OpenAIProvider: vi.fn().mockImplementation(function() {
      return {
        chat: mockOpenAIChat,
        listModels: vi.fn().mockResolvedValue(['gpt']),
      };
    }),
  };
});

describe('useChat System Prompt Clear Policy', () => {
  const { __testOnly: { __testOnlySetSettings } } = useSettings();
  const chatStore = useChat();
  const { sendMessage, createNewChat, openChat, updateChatSettings, updateChatGroupOverride } = chatStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(storageService.getSidebarStructure).mockImplementation(() => Promise.resolve(chatStore.rootItems.value));
    chatStore.__testOnly.__testOnlySetCurrentChat(null);
    __testOnlySetSettings({
      endpointType: 'openai',
      endpointUrl: 'http://global',
      defaultModelId: 'gpt',
      systemPrompt: 'Global System Prompt',
      autoTitleEnabled: false,
      storageType: 'local',
      providerProfiles: [],
    });
  });

  it('Policy: Override with null (Clear) should result in empty system message', async () => {
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat(id);

    // 1. Initial State: Global Default
    await sendMessage('Hello');
    expect(mockOpenAIChat).toHaveBeenLastCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([{ role: 'system', content: 'Global System Prompt' }])
    }));

    // 2. Chat-level Clear (behavior: override, content: null)
    await updateChatSettings(id, { 
      systemPrompt: { behavior: 'override', content: null } 
    });
    await sendMessage('Hello again');
    
    // Check that system prompt is NOT present
    const lastCall = mockOpenAIChat.mock.calls[mockOpenAIChat.mock.calls.length - 1]![0];
    const systemMessages = lastCall.messages.filter((m: any) => m.role === 'system');
    expect(systemMessages.length).toBe(0);
  });

  it('Policy: Override with empty string ("") should also result in empty system message', async () => {
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat(id);

    // Chat-level override with empty string
    await updateChatSettings(id, { 
      systemPrompt: { behavior: 'override', content: '' } 
    });
    await sendMessage('Empty string override');
    
    const lastCall = mockOpenAIChat.mock.calls[mockOpenAIChat.mock.calls.length - 1]![0];
    const systemMessages = lastCall.messages.filter((m: any) => m.role === 'system');
    expect(systemMessages.length).toBe(0);
  });

  it('Policy: Group-level Clear should affect chats in that group', async () => {
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat(id);

    // Create a group that Clears system prompt
    const group = reactive({
      id: 'g-clear', name: 'Clear Group', items: [], updatedAt: Date.now(), isCollapsed: false,
      systemPrompt: { behavior: 'override', content: null }
    }) as any;
    chatStore.rootItems.value = [{ id: 'chat_group:g-clear', type: 'chat_group', chatGroup: group }];
    
    await updateChatGroupOverride(id, 'g-clear');
    await nextTick();

    await sendMessage('In group');
    
    const lastCall = mockOpenAIChat.mock.calls[mockOpenAIChat.mock.calls.length - 1]![0];
    const systemMessages = lastCall.messages.filter((m: any) => m.role === 'system');
    expect(systemMessages.length).toBe(0);
  });

  it('Policy: Chat can Override a Group-level Clear', async () => {
    const chat = await createNewChat({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
    const id = chat!.id;
    await openChat(id);

    const group = reactive({
      id: 'g-clear', name: 'Clear Group', items: [], updatedAt: Date.now(), isCollapsed: false,
      systemPrompt: { behavior: 'override', content: null }
    }) as any;
    chatStore.rootItems.value = [{ id: 'chat_group:g-clear', type: 'chat_group', chatGroup: group }];
    await updateChatGroupOverride(id, 'g-clear');

    // Chat overrides with its own prompt
    await updateChatSettings(id, { 
      systemPrompt: { behavior: 'override', content: 'Chat Specific Prompt' } 
    });

    await sendMessage('Override');
    
    const lastCall = mockOpenAIChat.mock.calls[mockOpenAIChat.mock.calls.length - 1]![0];
    const systemMessages = lastCall.messages.filter((m: any) => m.role === 'system');
    expect(systemMessages[0].content).toBe('Chat Specific Prompt');
  });
});
