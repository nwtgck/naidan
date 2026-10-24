import { openChatLocalModelInput } from '@/composables/chat/chat-scoped/chat-local-model-input.test-support';
import { createChatContentWrite, readChatContentWrite, chatContentFingerprint, type ChatContentModelBinding } from '@/00-storage/service/chat-content-binding';
import type { StorageService } from '@/00-storage/service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive, toRaw } from 'vue';
import { z } from 'zod';
import type { LmProvider } from '@/01-models/lm';
import type { AssistantMessageNode, Chat, MessageNode, ToolMessageNode } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import type { Tool, ToolExecutionOutcome, ToolExecutionResult } from '@/01-models/tool';
import { toAttachmentId, toBinaryObjectId, toChatId, toMessageId, toToolCallId, type ChatId } from '@/01-models/ids';
import { getMessageText } from '@/01-models/message-text';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';

const state = vi.hoisted(() => ({
  active: new Map<ChatId, { controller: AbortController, chat: Chat }>(),
  current: { value: null as Chat | null },
  provider: undefined as LmProvider | undefined,
  tools: [] as Tool[],
  changed: vi.fn(),
  save: vi.fn(),
  captureWrite: vi.fn(),
  metadata: vi.fn(),
  notify: vi.fn(),
  title: vi.fn(),
  setError: vi.fn(),
  clearOutput: vi.fn(),
  drafts: vi.fn(),
  autoTitle: false,
  configured: true,
  resolvedModelId: 'm',
  endpointType: 'openai' as 'openai' | 'llama_cpp_browser',
  inspectModel: vi.fn(),
  openSettings: vi.fn(),
  fetchModels: vi.fn(async () => ['m']),
  setOnboardingDraft: vi.fn(),
  synchronizeBinding: vi.fn(),
  localPreparation: vi.fn(),
  saveAttachment: vi.fn(),
}));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  availableModels: { value: ['m'] },
  currentChatGroupRef: { value: null },
  currentChatRef: state.current,
  rootItems: { value: [] },
  getLiveChat: ({ chat }: { chat: Chat }) => chat,
  getLiveChatById: () => state.current.value,
  registerLiveInstance: vi.fn(),
  loadData: vi.fn(),
  synchronizeModelBindingContent: state.synchronizeBinding,
  ensureChatTmpDirectory: vi.fn(),
  triggerCurrentChat: state.changed,
  updateChatContent: state.save,
  updateChatMeta: state.metadata,
  isProcessing: ({ chatId }: { chatId: ChatId }) => state.active.has(chatId),
  chatRuntimeStore: {
    activeGenerations: state.active,
    getActiveGeneration: ({ chatId }: { chatId: ChatId }) => state.active.get(chatId),
    setActiveGeneration: ({ chatId, generation }: { chatId: ChatId, generation: { controller: AbortController, chat: Chat } }) => state.active.set(chatId, generation),
    deleteActiveGeneration: ({ chatId }: { chatId: ChatId }) => state.active.delete(chatId),
    startTask: vi.fn(),
    finishTask: vi.fn(),
  },
  chatVolatileState: {
    setToolCallDrafts: state.drafts,
    clearVolatileAssistantError: vi.fn(),
    setVolatileAssistantError: state.setError,
    setVolatileToolOutput: vi.fn(),
    appendVolatileToolOutput: vi.fn(),
    deleteVolatileToolOutput: state.clearOutput,
  },
}));
vi.mock('@/features/llama-cpp-browser/model-recovery/availability', () => ({ inspectLocalModel: state.inspectModel }));
vi.mock('@/features/lm/providerFactory', () => ({ loadLmProvider: async () => state.provider }));
vi.mock('@/features/llama-cpp-browser/composables/local-model-launch-session', () => ({ assertLocalModelLaunchReady: state.localPreparation }));
vi.mock('@/composables/chat/chat-scoped/chat-model-flow', () => ({ fetchAvailableModelsForChat: state.fetchModels }));
vi.mock('@/composables/chat/chat-scoped/chat-title-flow', () => ({ generateChatTitleForChat: state.title }));
vi.mock('@/composables/chat/chat-scoped/chat-processing-abort', () => ({ abortProcessingForChat: vi.fn() }));
vi.mock('@/composables/chat/chat-scoped/chat-image-flow', () => ({ handleImageGenerationForChat: vi.fn() }));
vi.mock('@/logic/chat-settings-resolver', () => ({ resolveChatSettings: () => ({ endpoint: state.endpointType === 'llama_cpp_browser' ? { type: 'llama_cpp_browser' } : { type: 'openai', url: state.configured ? 'https://example.invalid' : '' }, modelId: state.resolvedModelId, lmParameters: undefined, systemPromptMessages: [], autoTitleEnabled: state.autoTitle, sources: { endpoint: 'global', modelId: 'global' } }) }));
vi.mock('@/features/tools/factory', () => ({ getEnabledTools: async () => state.tools }));
vi.mock('@/features/tools/composables/useChatTools', () => ({ getEffectiveToolConfigsForChat: () => [] }));
vi.mock('@/features/tools/composables/useApproval', () => ({ useApproval: () => ({ ensureApproval: vi.fn() }) }));
vi.mock('@/features/tools/composables/useChoices', () => ({ useChoices: () => ({ requestChoice: vi.fn() }) }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: { value: { storageType: 'memory', experimental: { fakeLm: 'disabled' } } }, synchronizeModelBindingSettings: async () => 'synchronized', setOnboardingDraft: state.setOnboardingDraft }) }));
vi.mock('@/composables/useAppEntry', () => ({ requestAppSettings: state.openSettings }));
vi.mock('@/composables/useImageGeneration', () => ({ useImageGeneration: () => ({ isImageMode: () => false, getResolution: () => ({ width: 512, height: 512 }), getCount: () => 1, getSteps: () => undefined, getSeed: () => undefined, getPersistAs: () => 'original' }) }));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/composables/useConfirm', () => ({ useConfirm: () => ({ showConfirm: vi.fn() }) }));
vi.mock('@/composables/useStoragePersistence', () => ({ useStoragePersistence: () => ({ requestPersistence: vi.fn() }) }));
vi.mock('@/composables/chat/ui/useChatNavigation', () => ({ useChatNavigation: () => ({ openChat: vi.fn() }) }));
vi.mock('@/composables/chat/ui/useChatOrganization', () => ({ useChatOrganization: () => ({ reorderSidebarChatAfterSend: vi.fn() }) }));
vi.mock('@/00-storage/service', async () => ({ ChatContentBindingChangedError: (await import('@/00-storage/service/chat-content-binding')).ChatContentBindingChangedError, storageService: { getModelLaunch: vi.fn<StorageService['getModelLaunch']>().mockReturnValue(undefined), createChatContentWrite: state.captureWrite, captureSettingsStorage: () => () => true, loadChatContentWithoutAttachments: async () => null, notify: state.notify, getFile: vi.fn(), saveFile: state.saveAttachment, canPersistBinary: true } }));

import { generateResponseForAssistant, regenerateMessageForChat, sendMessageToTargetChat } from './chat-generation-flow';
import { withChatModelBindingFinalization } from './chat-model-binding-operations';

function createChat(): { chat: Chat, assistant: AssistantMessageNode } {
  const assistant: AssistantMessageNode = { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 2, parts: [], interruption: undefined, modelId: 'm', lmParameters: undefined, replies: { items: [] } };
  const user: MessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', createdAt: 1, parts: [{ type: 'text', text: 'question', completeness: 'complete' }], modelId: undefined, lmParameters: undefined, replies: { items: [assistant] } };
  const chat = reactive<Chat>({ id: toChatId({ raw: 'chat' }), title: null, root: { items: [user] }, currentLeafId: assistant.id, createdAt: 1, updatedAt: 1, debugEnabled: false });
  const node = chat.root.items[0]!.replies.items[0]!;
  if (node.role !== 'assistant') {
    throw new Error('Invalid fixture');
  }
  state.current.value = chat;
  return { chat, assistant: node };
}

const run = ({ chat, assistant }: { chat: Chat, assistant: AssistantMessageNode }) => generateResponseForAssistant({ chat, assistantId: assistant.id, lmParameters: undefined, onReady: undefined });

describe('chat generation flow with message parts', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    state.active.clear();
    state.autoTitle = false;
    state.configured = true;
    state.resolvedModelId = 'm';
    state.fetchModels.mockResolvedValue(['m']);
    state.endpointType = 'openai';
    state.inspectModel.mockResolvedValue('available');
    state.synchronizeBinding.mockResolvedValue('synchronized');
    state.localPreparation.mockReturnValue(undefined);
    state.saveAttachment.mockResolvedValue(undefined);
    state.tools = [];
    state.save.mockResolvedValue(undefined);
    state.captureWrite.mockImplementation(({ id, content, binding }: { id: Chat['id'], content: import('@/01-models/types').ChatContent | undefined, binding: ChatContentModelBinding | undefined }) => createChatContentWrite({ id, content, binding, isCurrent: () => true }));
    state.metadata.mockResolvedValue(undefined);
    state.title.mockResolvedValue(undefined);
  });

  it('rechecks the pinned initial local preparation after an attachment wait before connecting messages', async () => {
    const { chat } = createChat();
    chat.root.items = [];
    chat.currentLeafId = undefined;
    let current = true;
    const assertCurrent = vi.fn(() => {
      if (!current) {
        throw new Error('The initial local preparation changed');
      }
    });
    state.localPreparation.mockReturnValue({ assertCurrent });
    state.saveAttachment.mockImplementationOnce(async () => {
      current = false;
    });
    await expect(sendMessageToTargetChat({
      targetChat: chat,
      content: 'pending question',
      parentId: undefined,
      attachments: [{ id: toAttachmentId({ raw: 'local-file' }), binaryObjectId: toBinaryObjectId({ raw: 'local-file-body' }), originalName: 'x.txt', mimeType: 'text/plain', size: 1, uploadedAt: 1, status: 'memory', blob: new Blob(['x']) }],
      lmParameters: undefined,
    })).rejects.toThrow('The initial local preparation changed');
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(chat.root.items).toHaveLength(0);
    expect(state.save).not.toHaveBeenCalled();
    expect(state.metadata).not.toHaveBeenCalled();
  });

  it('rejects direct sends and assistant generation while another pane prepares a local model', async () => {
    const { chat, assistant } = createChat();
    const reservation = openChatLocalModelInput({ chatId: chat.id })!;
    using cleanup = {
      [Symbol.dispose]() {
        reservation.release();
      },
    };
    void cleanup;
    expect(await sendMessageToTargetChat({ targetChat: chat, content: 'keep draft', parentId: undefined, attachments: undefined, lmParameters: undefined })).toBe(false);
    await expect(run({ chat, assistant })).rejects.toThrow('The chat model binding changed before its content could be saved');
    expect(state.fetchModels).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
  });

  it('allows a send after an input is cancelled during attachment persistence', async () => {
    const { chat } = createChat();
    chat.root.items = [];
    state.saveAttachment.mockImplementationOnce(async () => {
      const reservation = openChatLocalModelInput({ chatId: chat.id })!;
      reservation.release();
    });
    expect(await sendMessageToTargetChat({ targetChat: chat, content: 'keep draft', parentId: undefined, attachments: [{ id: toAttachmentId({ raw: 'file' }), binaryObjectId: toBinaryObjectId({ raw: 'body' }), originalName: 'x.txt', mimeType: 'text/plain', size: 1, uploadedAt: 1, status: 'memory', blob: new Blob(['x']) }], lmParameters: undefined })).toBe(true);
    expect(chat.root.items.length).toBeGreaterThan(0);
    expect(state.save).toHaveBeenCalled();
  });

  it.each(['missing', 'unreadable'] as const)('rejects a receipt-free browser send with %s files before saving attachments or messages', async availability => {
    const { chat } = createChat();
    chat.root.items = [];
    chat.currentLeafId = undefined;
    state.endpointType = 'llama_cpp_browser';
    state.inspectModel.mockResolvedValue(availability);
    await expect(sendMessageToTargetChat({ targetChat: chat, content: 'keep this draft', parentId: undefined, attachments: [{ id: toAttachmentId({ raw: 'file' }), binaryObjectId: toBinaryObjectId({ raw: 'body' }), originalName: 'x.txt', mimeType: 'text/plain', size: 1, uploadedAt: 1, status: 'memory', blob: new Blob(['x']) }], lmParameters: undefined })).rejects.toThrow();
    expect(state.inspectModel).toHaveBeenCalledExactlyOnceWith({ modelId: 'm' });
    expect(state.saveAttachment).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
    expect(state.metadata).not.toHaveBeenCalled();
    expect(chat.root.items).toHaveLength(0);
  });

  it('rechecks ordinary browser files after attachment storage and keeps the message unconnected if they disappeared', async () => {
    const { chat } = createChat();
    chat.root.items = [];
    chat.currentLeafId = undefined;
    state.endpointType = 'llama_cpp_browser';
    state.inspectModel.mockResolvedValueOnce('available').mockResolvedValueOnce('missing');
    await expect(sendMessageToTargetChat({ targetChat: chat, content: 'keep this draft', parentId: undefined, attachments: [{ id: toAttachmentId({ raw: 'file' }), binaryObjectId: toBinaryObjectId({ raw: 'body' }), originalName: 'x.txt', mimeType: 'text/plain', size: 1, uploadedAt: 1, status: 'memory', blob: new Blob(['x']) }], lmParameters: undefined })).rejects.toThrow();
    expect(state.inspectModel).toHaveBeenCalledTimes(2);
    expect(state.saveAttachment).toHaveBeenCalledOnce();
    expect(state.save).not.toHaveBeenCalled();
    expect(state.metadata).not.toHaveBeenCalled();
    expect(chat.root.items).toHaveLength(0);
  });

  it('keeps the admitted content baseline through streaming despite newer model settings', async () => {
    const fixture = createChat();
    const originalContent = chatContentFingerprint({ content: fixture.chat });
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          started.resolve();
          await finish.promise;
          await writer.text({ type: 'text', text: 'accepted output' });
          return { type: 'finished', next: 'user' };
        },
      }),
    };
    const pending = run(fixture);
    await started.promise;
    fixture.chat.modelId = 'user/foreign-promotion';
    finish.resolve();
    await pending;
    expect(state.save).toHaveBeenCalled();
    const write = state.captureWrite.mock.results[0]!.value;
    expect(readChatContentWrite({ write, id: fixture.chat.id })).toMatchObject({ baseline: originalContent, binding: undefined });
    for (const [request] of state.save.mock.calls) {
      expect(request.write).toBe(write);
    }
  });

  it('keeps the background generation inside the fence after send has returned', async () => {
    const fixture = createChat();
    const finish = Promise.withResolvers<void>();
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await finish.promise;
          await writer.text({ type: 'text', text: 'answer' });
          return { type: 'finished', next: 'user' };
        },
      }),
    };
    expect(await sendMessageToTargetChat({ targetChat: fixture.chat, content: 'next question', parentId: undefined, attachments: undefined, lmParameters: undefined })).toBe(true);
    const committed = vi.fn();
    const finalization = withChatModelBindingFinalization({
      chatId: fixture.chat.id,
      operation: async () => {
        committed();
      },
    });
    await Promise.resolve();
    expect(committed).not.toHaveBeenCalled();
    finish.resolve();
    await finalization;
    expect(committed).toHaveBeenCalledOnce();
    expect(state.active.size).toBe(0);
  });

  it('opens connection settings when generation needs setup without sending the draft', async () => {
    const fixture = createChat();
    state.configured = false;
    const originalRoot = fixture.chat.root.items.length;
    expect(await sendMessageToTargetChat({ targetChat: fixture.chat, content: 'keep this draft', parentId: undefined, attachments: undefined, lmParameters: undefined })).toBe(false);
    expect(state.openSettings).toHaveBeenCalledExactlyOnceWith({ tab: 'connection', opener: undefined });
    expect(state.fetchModels).not.toHaveBeenCalled();
    expect(state.setOnboardingDraft).not.toHaveBeenCalled();
    expect(fixture.chat.root.items).toHaveLength(originalRoot);
    expect(state.save).not.toHaveBeenCalled();
    state.configured = true;
    state.endpointType = 'openai';
    state.inspectModel.mockResolvedValue('available');
    await Promise.resolve();
    expect(state.save).not.toHaveBeenCalled();
  });

  it('requests connection settings after one model lookup without creating a legacy draft when no model is selected', async () => {
    const fixture = createChat();
    state.resolvedModelId = '';
    state.fetchModels.mockResolvedValue([]);
    const originalRoot = fixture.chat.root.items.length;
    expect(await sendMessageToTargetChat({ targetChat: fixture.chat, content: 'keep this draft', parentId: undefined, attachments: undefined, lmParameters: undefined })).toBe(false);
    expect(state.fetchModels).toHaveBeenCalledExactlyOnceWith({ chatId: fixture.chat.id, errorSource: 'chat-generation-flow:resolve-models' });
    expect(state.openSettings).toHaveBeenCalledExactlyOnceWith({ tab: 'connection', opener: undefined });
    expect(state.setOnboardingDraft).not.toHaveBeenCalled();
    expect(fixture.chat.root.items).toHaveLength(originalRoot);
    expect(state.save).not.toHaveBeenCalled();
    state.resolvedModelId = 'm';
    await Promise.resolve();
    expect(state.fetchModels).toHaveBeenCalledOnce();
    expect(state.save).not.toHaveBeenCalled();
  });

  it('shows draft updates without history persistence and clears them after cancellation', async () => {
    const fixture = createChat();
    const visible = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    state.drafts.mockImplementation(({ drafts }) => {
      if (drafts.length !== 0) {
        visible.resolve();
      }
    });
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ messages, signal }) => {
        expect(messages.map(message => message.role)).toEqual(['user']);
        return createChatGenerationStream({
          signal,
          run: async ({ writer }) => {
            await writer.callDraft({ key: 0, name: 'shell', arguments: { offset: 0, text: '{"script":"' } });
            await release.promise;
            return { type: 'interrupted', reason: 'aborted' };
          },
        });
      },
    };
    const pending = run(fixture);
    await visible.promise;
    expect(fixture.assistant.parts).toEqual([]);
    expect(state.save).not.toHaveBeenCalled();
    const active = state.active.get(fixture.chat.id);
    if (!active) {
      throw new Error('Expected an active generation');
    }
    active.controller.abort(new DOMException('Aborted', 'AbortError'));
    expect(state.drafts).toHaveBeenLastCalledWith({ chatId: fixture.chat.id, messageId: fixture.assistant.id, owner: active.controller.signal, drafts: [] });
    release.resolve();
    await pending;
    expect(fixture.assistant.parts).toEqual([]);
    expect(fixture.assistant.interruption).toEqual({ type: 'cancelled' });
    state.drafts.mockReset();
  });

  it.each([true, false])('preserves the chat debug preference through tool rounds (%s)', async enabled => {
    const fixture = createChat();
    fixture.chat.debugEnabled = enabled;
    const preferences: Array<'on' | 'off' | undefined> = [];
    state.tools = [{ name: 'f', description: '', parametersSchema: z.object({}), execute: async () => ({ status: 'success', content: 'done' }) }];
    const { toToolCallId } = await import('@/01-models/ids');
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ debug, signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          preferences.push(debug);
          if (preferences.length === 1) {
            await writer.call({ key: 0, toolCall: { id: toToolCallId({ raw: 'debug-call' }), type: 'function', function: { name: 'f', arguments: '{}' } } });
            return { type: 'finished', next: 'tool_results' };
          }
          await writer.text({ type: 'text', text: 'answer' });
          return { type: 'finished', next: 'user' };
        },
      }),
    };
    await run(fixture);
    expect(preferences).toEqual([enabled ? 'on' : 'off', enabled ? 'on' : 'off']);
  });

  it('consumes structured reasoning and literal tags into the reserved new assistant', async () => {
    const fixture = createChat();
    state.provider = {
      listModels: async () => ['m'],
      chat: vi.fn<LmProvider['chat']>(({ messages, signal }) => {
        expect(messages.map(m => m.role)).toEqual(['user']);
        return createChatGenerationStream({
          signal,
          run: async ({ writer }) => {
            await writer.text({ type: 'reasoning', text: '  理由\n' });
            await writer.text({ type: 'text', text: '<think>literal</think>answer' });
            return { type: 'finished', next: 'user' };
          },
        });
      }),
    };
    await run(fixture);
    expect(fixture.assistant.parts).toMatchObject([{ type: 'reasoning', text: '  理由\n', completeness: 'complete' }, { type: 'text', text: '<think>literal</think>answer', completeness: 'complete' }]);
    expect(state.save).toHaveBeenCalled();
    expect(state.active.size).toBe(0);
    expect(fixture.assistant.interruption).toBeUndefined();
    expect(toRaw(fixture.chat.root.items[0]!.replies.items[0]!)).toBe(toRaw(fixture.assistant));
  });

  it('executes calls through the shared runner and creates a new assistant after its tool node', async () => {
    const fixture = createChat();
    const observed: readonly string[][] = [];
    const inputs = [...observed];
    const execute = vi.fn(async ({ args }: { args: unknown }) => ({ status: 'success' as const, content: JSON.stringify(args) }));
    state.tools = [{ name: 'f', description: 'f', parametersSchema: z.object({ n: z.number().default(1) }), execute }];
    let rounds = 0;
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ messages, signal }) => {
        inputs.push(messages.map(m => m.role));
        return createChatGenerationStream({
          signal,
          run: async ({ writer }) => {
            if (rounds++ === 0) {
              const { toToolCallId } = await import('@/01-models/ids');
              await writer.call({ key: 0, toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: ' {} ' } } });
              return { type: 'finished', next: 'tool_results' };
            }
            await writer.text({ type: 'text', text: 'answer' });
            return { type: 'finished', next: 'user' };
          },
        });
      },
    };
    await run(fixture);
    expect(inputs).toEqual([['user'], ['user', 'assistant', 'tool']]);
    expect(execute).toHaveBeenCalledOnce();
    const tool = fixture.assistant.replies.items[0]!;
    expect(tool.role).toBe('tool');
    expect(tool.parts[0]).toMatchObject({ type: 'tool_result', result: { status: 'success', content: { text: '{"n":1}' } } });
    const answer = tool.replies.items[0]!;
    expect(getMessageText({ message: answer })).toBe('answer');
    expect(answer.id).not.toBe(fixture.assistant.id);
    expect(fixture.chat.currentLeafId).toBe(answer.id);
    expect(fixture.assistant.parts[0]).toMatchObject({ toolCall: { function: { arguments: ' {} ' } } });
  });

  it('records cancellation and does not close an open literal tag or append Aborted', async () => {
    const fixture = createChat();
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: '<think>途中' });
      state.active.get(fixture.chat.id)!.controller.abort();
      return { type: 'interrupted', reason: 'aborted' };
        },
      }),
    };
    await run(fixture);
    expect(fixture.assistant.parts[0]).toMatchObject({ text: '<think>途中', completeness: 'partial' });
    expect(fixture.assistant.interruption).toEqual({ type: 'cancelled' });
    expect(state.active.size).toBe(0);
  });

  it('retains received content and records the model failure without changing the text', async () => {
    const fixture = createChat();
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: 'prefix' });
          throw new Error('通信失敗');
        },
      }),
    };
    await run(fixture);
    expect(getMessageText({ message: fixture.assistant })).toBe('prefix');
    expect(fixture.assistant.interruption).toEqual({ type: 'error', message: '通信失敗' });
    expect(state.setError).toHaveBeenCalledWith({ chatId: fixture.chat.id, messageId: fixture.assistant.id, error: '通信失敗' });
  });

  it('does not reclassify a successful answer as a model error when automatic title fails', async () => {
    const fixture = createChat();
    state.autoTitle = true;
    state.title.mockRejectedValue(new Error('title failed'));
    using _consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: 'answer' });
          return { type: 'finished', next: 'user' };
        },
      }),
    };
    await run(fixture);
    expect(fixture.assistant.interruption).toBeUndefined();
    expect(fixture.assistant.parts[0]).toMatchObject({ text: 'answer', completeness: 'complete' });
    expect(state.active.size).toBe(0);
  });
});

describe('chat generation ownership and failure boundaries', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    state.active.clear();
    state.tools = [];
    state.autoTitle = false;
    state.save.mockResolvedValue(undefined);
    state.metadata.mockResolvedValue(undefined);
    state.title.mockResolvedValue(undefined);
  });

  it('does not open an existing partial assistant as a new generation', async () => {
    const fixture = createChat();
    fixture.assistant.parts = [{ type: 'text', text: 'old', completeness: 'partial' }];
    fixture.assistant.interruption = { type: 'cancelled' };
    const before = JSON.stringify(fixture.assistant);
    await expect(run(fixture)).rejects.toThrow(/cannot be resumed/);
    expect(JSON.stringify(fixture.assistant)).toBe(before);
    expect(state.active.size).toBe(0);
  });

  it('keeps a successful answer in memory and skips reload metadata when persistence fails', async () => {
    const fixture = createChat();
    const failure = new Error('disk unavailable');
    state.save.mockResolvedValueOnce(undefined).mockRejectedValue(failure);
    using _consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: 'answer' });
          return { type: 'finished', next: 'user' };
        },
      }),
    };
    await run(fixture);
    expect(fixture.assistant.parts[0]).toMatchObject({ text: 'answer', completeness: 'complete' });
    expect(fixture.assistant.interruption).toBeUndefined();
    expect(state.metadata).not.toHaveBeenCalled();
  });

  it('keeps an observed tool success when stop is requested inside tool execution', async () => {
    const fixture = createChat();
    const dispose = vi.fn();
    state.tools = [{
      name: 'f',
      description: '',
      parametersSchema: z.object({}),
      execute: async () => {
      state.active.get(fixture.chat.id)!.controller.abort();
      return { status: 'success', content: 'observed success' };
      },
      dispose,
    }];
    const { toToolCallId } = await import('@/01-models/ids');
    const chat = vi.fn<LmProvider['chat']>(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.call({ key: 0, toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'f', arguments: '{}' } } });
        return { type: 'finished', next: 'tool_results' };
      },
    }));
    state.provider = { listModels: async () => ['m'], chat };
    await run(fixture);
    const tool = fixture.assistant.replies.items[0]!;
    expect(tool.parts[0]).toMatchObject({ result: { status: 'success', content: { text: 'observed success' } } });
    expect(chat).toHaveBeenCalledOnce();
    expect(tool.replies.items).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function createToolRetryFixture({ results }: { results: ToolExecutionResult[] }): {
  chat: Chat;
  tool: ToolMessageNode;
  stopped: AssistantMessageNode;
} {
  const fixture = createChat();
  fixture.assistant.parts = results.map((result, index) => ({
    type: 'tool_call',
    toolCall: { id: result.toolCallId, type: 'function', function: { name: 'calculator', arguments: `{"value":${index}}` } },
  }));
  const stopped: AssistantMessageNode = {
    id: toMessageId({ raw: 'stopped-answer' }),
    role: 'assistant',
    createdAt: 0,
    parts: [{ type: 'text', text: '<think>stopped answer', completeness: 'partial' }],
    modelId: 'm',
    lmParameters: { ...EMPTY_LM_PARAMETERS, temperature: 0.25 },
    interruption: { type: 'cancelled' },
    replies: { items: [] },
  };
  fixture.assistant.replies.items.push({
    id: toMessageId({ raw: 'tool-results' }),
    role: 'tool',
    createdAt: 3,
    parts: results.map((result) => ({ type: 'tool_result', result })),
    modelId: undefined,
    lmParameters: undefined,
    replies: { items: [stopped] },
  });
  const tool = fixture.assistant.replies.items[0]!;
  if (tool.role !== 'tool') {
    throw new Error('Expected tool fixture');
  }
  const stoppedNode = tool.replies.items[0]!;
  if (stoppedNode.role !== 'assistant') {
    throw new Error('Expected stopped assistant fixture');
  }
  fixture.chat.currentLeafId = stoppedNode.id;
  return { chat: fixture.chat, tool, stopped: stoppedNode };
}

describe('regeneration after tool results', () => {
  beforeEach(async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    vi.clearAllMocks();
    state.active.clear();
    state.autoTitle = false;
    state.tools = [];
    state.save.mockResolvedValue(undefined);
    state.metadata.mockResolvedValue(undefined);
    state.title.mockResolvedValue(undefined);
  });

  it.each(['success', 'error'] as const)('retries the answer after a %s tool result without executing the historical call again', async status => {
    const fixture = createChat();
    const outcome: ToolExecutionOutcome = status === 'success'
      ? { status, content: '\ufeff 391\r\n' }
      : { status, code: 'execution_failed', message: '  計算に失敗しました\n' };
    const execute = vi.fn<Tool['execute']>(async () => outcome);
    state.tools = [{ name: 'calculator', description: 'calculate', parametersSchema: z.object({}), execute }];
    let round = 0;
    const chat = vi.fn<LmProvider['chat']>(({ signal }) => {
      const iteration = round++;
      return createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          if (iteration === 0) {
            await writer.call({ key: 0, toolCall: { id: toToolCallId({ raw: 'calculation' }), type: 'function', function: { name: 'calculator', arguments: ' {} ' } } });
            return { type: 'finished', next: 'tool_results' };
          }
          if (iteration === 1) {
            await writer.text({ type: 'reasoning', text: '  結果を確認する。\n' });
            await writer.text({ type: 'text', text: '<think>literal answer prefix' });
            throw new Error('Answer failed after the tool completed');
          }
          await writer.text({ type: 'text', text: '  Fresh answer\n' });
          return { type: 'finished', next: 'user' };
        },
      });
    });
    state.provider = { listModels: async () => ['m'], chat };
    await run(fixture);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledOnce();
    const tool = fixture.assistant.replies.items[0]!;
    if (tool.role !== 'tool') {
      throw new Error('Expected the completed tool message');
    }
    const failed = tool.replies.items[0]!;
    if (failed.role !== 'assistant') {
      throw new Error('Expected the failed answer');
    }
    expect(failed.interruption).toEqual({ type: 'error', message: 'Answer failed after the tool completed' });
    expect(failed.parts).toMatchObject([
      { type: 'reasoning', text: '  結果を確認する。\n', completeness: 'complete' },
      { type: 'text', text: '<think>literal answer prefix', completeness: 'partial' },
    ]);
    const oldAnswer = JSON.stringify(failed);
    const toolParts = JSON.stringify(tool.parts);
    const callParts = JSON.stringify(fixture.assistant.parts);

    await regenerateMessageForChat({ chatId: fixture.chat.id, failedMessageId: failed.id });
    await vi.waitUntil(() => !state.active.has(fixture.chat.id));
    expect(chat).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledOnce();
    expect(tool.replies.items).toHaveLength(2);
    const retried = tool.replies.items[1]!;
    expect(retried.role).toBe('assistant');
    expect(retried.id).not.toBe(failed.id);
    expect(fixture.chat.currentLeafId).toBe(retried.id);
    expect(retried.parts).toMatchObject([{ type: 'text', text: '  Fresh answer\n', completeness: 'complete' }]);
    if (retried.role !== 'assistant') {
      throw new Error('Expected the retried answer');
    }
    expect(retried.interruption).toBeUndefined();
    expect(retried.modelId).toBe(failed.modelId);
    expect(retried.lmParameters).toEqual(failed.lmParameters);
    expect(JSON.stringify(failed)).toBe(oldAnswer);
    expect(JSON.stringify(tool.parts)).toBe(toolParts);
    expect(JSON.stringify(fixture.assistant.parts)).toBe(callParts);
    const previousInput = chat.mock.calls[1]![0].messages;
    const retryInput = chat.mock.calls[2]![0].messages;
    expect(retryInput).toEqual(previousInput);
    expect(retryInput.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(retryInput.some(message => message.id === failed.id || message.id === retried.id)).toBe(false);
    expect(state.save).toHaveBeenCalled();
  });

  it('creates a fresh answer after mixed completed results while retaining the stopped sibling', async () => {
    const results: ToolExecutionResult[] = [
      { toolCallId: toToolCallId({ raw: 'success-call' }), status: 'success', content: { type: 'text', text: '\ufeff 391\n' } },
      { toolCallId: toToolCallId({ raw: 'error-call' }), status: 'error', error: { code: 'timeout', message: { type: 'text', text: '  タイムアウト\n' } } },
    ];
    const fixture = createToolRetryFixture({ results });
    const before = JSON.stringify(fixture.stopped);
    const previousResults = JSON.stringify(fixture.tool.parts);
    const execute = vi.fn<Tool['execute']>();
    state.tools = [{ name: 'calculator', description: 'calculate', parametersSchema: z.object({}), execute }];
    const chat = vi.fn<LmProvider['chat']>(({ signal }) => createChatGenerationStream({
      signal,
      run: async ({ writer }) => {
        await writer.text({ type: 'text', text: 'A completely new answer' });
        return { type: 'finished', next: 'user' };
      },
    }));
    state.provider = { listModels: async () => ['m'], chat };
    await regenerateMessageForChat({ chatId: fixture.chat.id, failedMessageId: fixture.stopped.id });
    await vi.waitUntil(() => !state.active.has(fixture.chat.id));
    expect(chat).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.tool.replies.items).toHaveLength(2);
    const sibling = fixture.tool.replies.items[1]!;
    expect(sibling.id).not.toBe(fixture.stopped.id);
    expect(getMessageText({ message: sibling })).toBe('A completely new answer');
    expect(JSON.stringify(fixture.stopped)).toBe(before);
    expect(JSON.stringify(fixture.tool.parts)).toBe(previousResults);
    const request = chat.mock.calls[0]![0];
    expect(request.parameters?.temperature).toBe(0.25);
    expect(request.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(request.messages.at(-1)?.parts).toEqual(fixture.tool.parts);
    expect(fixture.stopped.createdAt).toBe(0);
  });

  it('keeps both interrupted answers when a retry itself fails', async () => {
    const fixture = createToolRetryFixture({ results: [{ toolCallId: toToolCallId({ raw: 'call' }), status: 'success', content: { type: 'text', text: 'done' } }] });
    const before = JSON.stringify(fixture.stopped);
    state.provider = {
      listModels: async () => ['m'],
      chat: ({ signal }) => createChatGenerationStream({
        signal,
        run: async ({ writer }) => {
          await writer.text({ type: 'text', text: 'Another incomplete answer' });
          throw new Error('Retry failed');
        },
      }),
    };
    await regenerateMessageForChat({ chatId: fixture.chat.id, failedMessageId: fixture.stopped.id });
    await vi.waitUntil(() => !state.active.has(fixture.chat.id));
    expect(fixture.tool.replies.items).toHaveLength(2);
    const sibling = fixture.tool.replies.items[1]!;
    if (sibling.role !== 'assistant') {
      throw new Error('Expected retried assistant');
    }
    expect(sibling.interruption).toEqual({ type: 'error', message: 'Retry failed' });
    expect(sibling.parts).toMatchObject([{ type: 'text', text: 'Another incomplete answer', completeness: 'partial' }]);
    expect(fixture.chat.currentLeafId).toBe(sibling.id);
    expect(JSON.stringify(fixture.stopped)).toBe(before);
  });

  it.each(['empty', 'executing', 'mixed'] as const)('does not retry an answer before its %s tool results are complete', async mode => {
    const executing: ToolExecutionResult = { toolCallId: toToolCallId({ raw: 'still-running' }), status: 'executing' };
    const results: ToolExecutionResult[] = mode === 'empty' ? [] : mode === 'executing' ? [executing] : [
      { toolCallId: toToolCallId({ raw: 'finished' }), status: 'success', content: { type: 'text', text: 'done' } }, executing,
    ];
    const fixture = createToolRetryFixture({ results });
    const before = JSON.stringify(fixture.chat);
    const chat = vi.fn<LmProvider['chat']>();
    state.provider = { listModels: async () => ['m'], chat };
    await regenerateMessageForChat({ chatId: fixture.chat.id, failedMessageId: fixture.stopped.id });
    expect(chat).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
    expect(state.metadata).not.toHaveBeenCalled();
    expect(state.active.size).toBe(0);
    expect(JSON.stringify(fixture.chat)).toBe(before);
  });
});
