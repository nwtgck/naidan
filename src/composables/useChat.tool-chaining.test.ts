import { describe, it, expect, vi, beforeEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useChat } from './useChat';
import { storageService } from '@/00-storage/service';
import { reactive, nextTick, computed } from 'vue';
import type { Chat, SidebarItem, Hierarchy } from '@/01-models/types';
import { useGlobalEvents } from './useGlobalEvents';
import { toChatId } from '@/01-models/ids';

// Mock storage service state
const mockRootItems: SidebarItem[] = [];
let mockHierarchy: Hierarchy = { items: [] };

vi.mock('../00-storage/service', () => ({
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
    loadChatGroup: vi.fn().mockResolvedValue(null),
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
    settings: { value: { endpoint: { type: 'openai', url: 'http://localhost' }, storageType: 'local', titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } }, defaultModelId: 'gpt-4' } },
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

// Mock LM Provider
const mockLmChat = vi.fn();

vi.mock('../features/lm/openai', () => ({
  OpenAIProvider: function() {
    return {
      chat: mockLmChat,
      listModels: vi.fn().mockResolvedValue(['gpt-4']),
    };
  },
}));

vi.mock('../features/lm/ollama', () => ({
  OllamaProvider: function() {
    return {
      chat: vi.fn(),
      listModels: vi.fn().mockResolvedValue(['gpt-4']),
    };
  },
}));

// Mock Tools Registry
vi.mock('../features/tools/registry', () => ({
  ALL_TOOLS: [
    {
      name: 'calculator',
      description: 'Calculator',
      parametersSchema: { strict: () => ({ parse: (args: any) => args }) },
      execute: vi.fn().mockResolvedValue({ status: 'success', content: '42' }),
    },
  ],
}));

vi.mock('../features/tools/composables/useChatTools', () => ({
  getEffectiveToolConfigsForChat: ({ chat }: { chat: { toolConfigs?: unknown } }) => chat.toolConfigs ?? [{ key: 'builtin.calculator', status: 'enabled' }],
  useChatTools: () => ({
    enabledToolNames: { value: ['calculator'] },
  }),
}));

vi.mock('../features/tools/composables/useChatWeshPreferences', () => ({
  useChatWeshPreferences: () => ({
    getNaidanSysfsAccessScope: vi.fn(() => 'none'),
  }),
}));


describe('useChat Tool Chaining', () => {
  const chatStore = useChat();
  const {
    activeMessages, sendMessage, streaming, TEST_ONLY,
  } = chatStore;
  const { __testOnlySetCurrentChat } = TEST_ONLY;

  const { clearEvents } = useGlobalEvents();

  beforeEach(() => {
    vi.clearAllMocks();
    __testOnlySetCurrentChat({ chat: null });
    chatStore.rootItems.value = [];
    mockRootItems.length = 0;
    mockHierarchy = { items: [] };
    clearEvents();

    // Setup persistence mocks
    vi.mocked(storageService.updateChatMeta).mockResolvedValue(undefined);
    vi.mocked(storageService.saveFile).mockResolvedValue(undefined);
    vi.mocked(storageService.updateChatContent).mockImplementation(({ updater }) => {
      return Promise.resolve(updater({ current: { root: { items: [] }, currentLeafId: undefined } })) as any;
    });
    vi.mocked(storageService.loadHierarchy).mockImplementation(() => Promise.resolve(mockHierarchy));
  });

  it('should chain multiple tool calls in the active thread', async () => {
    const chat: Chat = reactive({
      id: toChatId({ raw: 'chat-1' }),
      title: 'Tool Test',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: true,
      endpoint: {
        type: 'openai',
        url: 'http://localhost',
      },
      modelId: 'gpt-4',
    });
    __testOnlySetCurrentChat({ chat });

    // Mock LM to return two tool calls
    mockLmChat.mockImplementation(async (params) => {
      const { onToolCall, onToolResult, onChunk, onAssistantMessageStart } = params;

      // Iteration 1: Assistant makes tool calls
      onAssistantMessageStart?.();
      onToolCall({
        id: 'call-1',
        toolName: 'calculator',
        modelVisibleArguments: '{"expression":"1+1"}',
      });
      await nextTick();
      await onToolResult({ id: 'call-1', result: { status: 'success', content: '2' } });
      await nextTick();

      onToolCall({
        id: 'call-2',
        toolName: 'calculator',
        modelVisibleArguments: '{"expression":"2+2"}',
      });
      await nextTick();
      await onToolResult({ id: 'call-2', result: { status: 'success', content: '4' } });
      await nextTick();

      // Iteration 2: Assistant responds with final text
      onAssistantMessageStart?.();
      onChunk({ chunk: 'Final answer is 4.' });
      await nextTick();
    });

    await sendMessage({ content: 'Calculate 1+1 and 2+2' });

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

    const { useChatDisplayFlow } = await import('./useChatDisplayFlow');
    const { chatFlow } = useChatDisplayFlow({
      chat: computed(() => chat),
      isProcessing: () => false,
    });
    const displayMessages = chatFlow.value;
    console.log('Display messages types:', displayMessages.map(d => d.type));

    // New structure: user, assistant1 (calls), tool (consolidated), assistant2 (final)
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    // chatFlow groups internal atoms (tool_calls, tool_group, completed thinking) into process_sequence.
    // Here: [message(user), process_sequence(assistant tool_calls + tool_group), message(assistant final answer)]
    expect(displayMessages.map(d => d.type)).toEqual(['message', 'process_sequence', 'message']);

    const seq = displayMessages[1] as { type: 'process_sequence', items: any[] };
    expect(seq.items).toHaveLength(2);
    expect(seq.items[0].type).toBe('message');
    expect(seq.items[0].mode).toBe('tool_calls');
    expect(seq.items[1].type).toBe('tool_group');
    expect(seq.items[1].toolCalls).toHaveLength(2);
    expect(seq.items[1].toolCalls[0].id).toBe('call-1');
    expect(seq.items[1].toolCalls[1].id).toBe('call-2');

    // Check tree structure
    const assistant1 = messages[1]!;
    const toolNode = messages[2]!;
    const assistant2 = messages[3]!;

    expect(assistant1.toolCalls?.map((toolCall) => toolCall.function.arguments)).toEqual([
      '{"expression":"1+1"}',
      '{"expression":"2+2"}',
    ]);
    expect(assistant1.replies.items).toContain(toolNode);
    expect(toolNode.replies.items).toContain(assistant2);
  });

  it('should preserve model-visible tool history when rebuilding the next user turn', async () => {
    const chat: Chat = reactive({
      id: toChatId({ raw: 'chat-prefix-continuity' }),
      title: 'Prefix Continuity Test',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: true,
      endpoint: {
        type: 'openai',
        url: 'http://localhost',
      },
      modelId: 'gpt-4',
    });
    __testOnlySetCurrentChat({ chat });

    let generationNumber = 0;
    mockLmChat.mockImplementation(async (params) => {
      generationNumber += 1;
      const { onToolCall, onToolResult, onChunk, onAssistantMessageStart } = params;

      onAssistantMessageStart?.();
      if (generationNumber === 1) {
        onChunk({ chunk: '<think>tool-call reasoning</think>' });
        onToolCall?.({
          id: 'call-invalid',
          toolName: 'calculator',
          modelVisibleArguments: '{"expression":"1+1"}',
        });
        await onToolResult?.({
          id: 'call-invalid',
          result: {
            status: 'error',
            code: 'invalid_arguments',
            message: 'Invalid arguments: test fixture',
          },
        });
        onAssistantMessageStart?.();
        onChunk({ chunk: 'Recovered from the tool error.' });
      } else {
        onChunk({ chunk: 'Second answer.' });
      }
    });

    await sendMessage({ content: 'First request' });
    await flushPromises();
    await nextTick();
    await sendMessage({ content: 'Second request' });
    await flushPromises();
    await nextTick();

    expect(mockLmChat).toHaveBeenCalledTimes(2);
    const secondGenerationMessages = mockLmChat.mock.calls[1]![0].messages;
    expect(secondGenerationMessages).toEqual([
      { role: 'user', content: 'First request', tool_calls: undefined },
      {
        role: 'assistant',
        content: '<think>tool-call reasoning</think>',
        tool_calls: [{
          id: 'call-invalid',
          type: 'function',
          function: {
            name: 'calculator',
            arguments: '{"expression":"1+1"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call-invalid',
        content: 'Error [invalid_arguments]: Invalid arguments: test fixture',
      },
      { role: 'assistant', content: 'Recovered from the tool error.', tool_calls: undefined },
      { role: 'user', content: 'Second request', tool_calls: undefined },
    ]);
  });

  it('should correctly follow the branch even with multiple root items', async () => {
    const chat: Chat = reactive({
      id: toChatId({ raw: 'chat-2' }),
      title: 'Branch Test',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: true,
      endpoint: {
        type: 'openai',
        url: 'http://localhost',
      },
      modelId: 'gpt-4',
    });
    __testOnlySetCurrentChat({ chat });

    // Add first root item
    await sendMessage({ content: 'Message 1' });
    await flushPromises();
    await nextTick();

    // Add second root item (new thread)
    await sendMessage({ content: 'Message 2', parentId: null });
    await flushPromises();
    await nextTick();

    expect(chat.root.items).toHaveLength(2);

    // Last leaf should be in the second thread
    const messages = activeMessages.value;
    expect(messages[0]!.content).toBe('Message 2');
  });

  it('should not finish a generation before asynchronous tool-result persistence settles', async () => {
    const chat: Chat = reactive({
      id: toChatId({ raw: 'chat-tool-result-persistence' }),
      title: 'Tool Result Persistence Test',
      root: { items: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      debugEnabled: true,
      endpoint: {
        type: 'openai',
        url: 'http://localhost',
      },
      modelId: 'gpt-4',
    });
    __testOnlySetCurrentChat({ chat });

    let releaseSave: (() => void) | undefined;
    vi.mocked(storageService.saveFile).mockImplementation(() => new Promise<void>(resolve => {
      releaseSave = resolve;
    }));

    mockLmChat.mockImplementation(async (params) => {
      const { onToolCall, onToolResult, onChunk, onAssistantMessageStart } = params;
      onAssistantMessageStart?.();
      onToolCall?.({
        id: 'call-large-result',
        toolName: 'calculator',
        modelVisibleArguments: '{"expression":"1+1"}',
      });
      onToolResult?.({
        id: 'call-large-result',
        result: { status: 'success', content: 'x'.repeat(100 * 1024 + 1) },
      });
      onAssistantMessageStart?.();
      onChunk({ chunk: 'Done.' });
    });

    await sendMessage({ content: 'Persist a large result' });
    await vi.waitUntil(() => vi.mocked(storageService.saveFile).mock.calls.length > 0);
    await flushPromises();
    expect(streaming.value).toBe(true);

    releaseSave!();
    await vi.waitUntil(() => !streaming.value);

    const toolMessage = activeMessages.value.find((message) => message.role === 'tool');
    expect(toolMessage?.role).toBe('tool');
    if (toolMessage?.role !== 'tool') throw new Error('Expected a persisted Tool Result message.');
    expect(toolMessage.results[0]?.status).toBe('success');
    if (toolMessage.results[0]?.status !== 'success') throw new Error('Expected a successful Tool Result.');
    expect(toolMessage.results[0].content.type).toBe('binary_object');
  });

});
