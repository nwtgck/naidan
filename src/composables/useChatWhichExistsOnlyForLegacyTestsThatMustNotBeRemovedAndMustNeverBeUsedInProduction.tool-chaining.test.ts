import { z } from 'zod';
import type { LmProvider } from '@/01-models/lm';
import type { Tool } from '@/01-models/tool';
import { getMessageText } from '@/01-models/message-text';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction } from './useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction';
import { storageService } from '@/00-storage/service';
import { reactive, nextTick, computed } from 'vue';
import type { Chat, SidebarItem, Hierarchy } from '@/01-models/types';
import { useGlobalEvents } from './useGlobalEvents';
import { toChatId, toToolCallId } from '@/01-models/ids';

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
const mockLmChat = vi.fn<LmProvider['chat']>();
const mockToolExecute = vi.fn<Tool['execute']>();

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

// The real tool factory supplies this execution double to the shared turn runner.
vi.mock('../features/tools/calculator', () => ({
  CalculatorTool: class {
    name = 'calculator';
    description = 'Calculator';
    parametersSchema = z.object({ expression: z.string() });
    execute = mockToolExecute;
  },
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


describe('useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction Tool Chaining', () => {
  const chatStore = useChatWhichExistsOnlyForLegacyTestsThatMustNotBeRemovedAndMustNeverBeUsedInProduction();
  const {
    activeMessages, sendMessage, streaming, TEST_ONLY,
  } = chatStore;
  const { __testOnlySetCurrentChat } = TEST_ONLY;

  const { clearEvents } = useGlobalEvents();

  beforeEach(() => {
    vi.clearAllMocks();
    mockToolExecute.mockReset().mockResolvedValue({ status: 'success', content: '42' });
    mockLmChat.mockReset().mockImplementation(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'Response' });
        return { type: 'finished', next: 'user' };
      },
    }));
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

  afterEach(async () => {
    await vi.waitUntil(() => TEST_ONLY.activeGenerations.size === 0);
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

    mockToolExecute
      .mockResolvedValueOnce({ status: 'success', content: '2' })
      .mockResolvedValueOnce({ status: 'success', content: '4' });
    // Each provider call generates one assistant; the shared runner executes tools.
    mockLmChat
      .mockImplementationOnce(({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.call({ key: 0, toolCall: {
            id: toToolCallId({ raw: 'call-1' }), type: 'function',
            function: { name: 'calculator', arguments: '{"expression":"1+1"}' },
          } });
          await writer.call({ key: 1, toolCall: {
            id: toToolCallId({ raw: 'call-2' }), type: 'function',
            function: { name: 'calculator', arguments: '{"expression":"2+2"}' },
          } });
          return { type: 'finished', next: 'tool_results' };
        },
      }))
      .mockImplementationOnce(({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: 'Final answer is 4.' });
          return { type: 'finished', next: 'user' };
        },
      }));

    await sendMessage({ content: 'Calculate 1+1 and 2+2' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));
    expect(mockLmChat).toHaveBeenCalledTimes(2);
    expect(mockToolExecute).toHaveBeenNthCalledWith(1, expect.objectContaining({ args: { expression: '1+1' } }));
    expect(mockToolExecute).toHaveBeenNthCalledWith(2, expect.objectContaining({ args: { expression: '2+2' } }));
    const messages = activeMessages.value;

    const { useChatDisplayFlow } = await import('./useChatDisplayFlow');
    const { chatFlow } = useChatDisplayFlow({
      chat: computed(() => chat),
      isProcessing: () => false,
    });
    const displayMessages = chatFlow.value;

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

    expect(assistant1.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall.function.arguments)).toEqual([
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

    mockToolExecute.mockResolvedValueOnce({
      status: 'error', code: 'invalid_arguments', message: 'Invalid arguments: test fixture',
    });
    mockLmChat
      .mockImplementationOnce(({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: '<think>tool-call reasoning</think>' });
          await writer.call({ key: 0, toolCall: {
            id: toToolCallId({ raw: 'call-invalid' }), type: 'function',
            function: { name: 'calculator', arguments: '{"expression":"1+1"}' },
          } });
          return { type: 'finished', next: 'tool_results' };
        },
      }))
      .mockImplementationOnce(({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: 'Recovered from the tool error.' });
          return { type: 'finished', next: 'user' };
        },
      }))
      .mockImplementationOnce(({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: 'Second answer.' });
          return { type: 'finished', next: 'user' };
        },
      }));

    await sendMessage({ content: 'First request' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));
    await sendMessage({ content: 'Second request' });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));

    expect(mockLmChat).toHaveBeenCalledTimes(3);
    const continuationMessages = mockLmChat.mock.calls[1]![0].messages;
    const secondTurnMessages = mockLmChat.mock.calls[2]![0].messages;
    expect(secondTurnMessages.slice(0, continuationMessages.length)).toEqual(continuationMessages);
    expect(secondTurnMessages).toEqual([
      { id: expect.any(String), role: 'user', parts: [
        { id: expect.any(String), type: 'text', text: 'First request', completeness: 'complete' },
      ] },
      { id: expect.any(String), role: 'assistant', parts: [
        { id: 'part_0', type: 'text', text: '<think>tool-call reasoning</think>', completeness: 'complete' },
        { id: 'part_1', type: 'tool_call', toolCall: {
          id: 'call-invalid', type: 'function',
          function: { name: 'calculator', arguments: '{"expression":"1+1"}' },
        } },
      ] },
      { id: expect.any(String), role: 'tool', parts: [
        { id: 'tool_result_0', type: 'tool_result', result: {
          toolCallId: 'call-invalid', status: 'error',
          error: { code: 'invalid_arguments', message: { type: 'text', text: 'Invalid arguments: test fixture' } },
        } },
      ] },
      { id: expect.any(String), role: 'assistant', parts: [
        { id: 'part_0', type: 'text', text: 'Recovered from the tool error.', completeness: 'complete' },
      ] },
      { id: expect.any(String), role: 'user', parts: [
        { id: expect.any(String), type: 'text', text: 'Second request', completeness: 'complete' },
      ] },
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
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));
    await flushPromises();
    await nextTick();

    // Add second root item (new thread)
    await sendMessage({ content: 'Message 2', parentId: null });
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));
    await flushPromises();
    await nextTick();

    expect(chat.root.items).toHaveLength(2);

    // Last leaf should be in the second thread
    const messages = activeMessages.value;
    expect(getMessageText({ message: messages[0]! })).toBe('Message 2');
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

    mockToolExecute.mockResolvedValueOnce({ status: 'success', content: 'x'.repeat(100 * 1024 + 1) });
    mockLmChat
      .mockImplementationOnce(({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.call({ key: 0, toolCall: {
            id: toToolCallId({ raw: 'call-large-result' }), type: 'function',
            function: { name: 'calculator', arguments: '{"expression":"1+1"}' },
          } });
          return { type: 'finished', next: 'tool_results' };
        },
      }))
      .mockImplementationOnce(({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: 'Done.' });
          return { type: 'finished', next: 'user' };
        },
      }));

    await sendMessage({ content: 'Persist a large result' });
    await vi.waitUntil(() => vi.mocked(storageService.saveFile).mock.calls.length > 0);
    await flushPromises();
    expect(streaming.value).toBe(true);
    expect(mockLmChat).toHaveBeenCalledTimes(1);

    releaseSave!();
    await vi.waitUntil(() => !chatStore.isProcessing({ chatId: chat.id }));
    expect(mockLmChat).toHaveBeenCalledTimes(2);

    const toolMessage = activeMessages.value.find((message) => message.role === 'tool');
    expect(toolMessage?.role).toBe('tool');
    if (toolMessage?.role !== 'tool') throw new Error('Expected a persisted Tool Result message.');
    const result = toolMessage.parts[0]?.result;
    expect(result?.status).toBe('success');
    if (result?.status !== 'success') throw new Error('Expected a successful Tool Result.');
    expect(result.content.type).toBe('binary_object');
  });

});
