import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatGenerationItem, ChatGenerationResult, LmProvider } from '@/01-models/lm';
import type { Chat, ChatContent, ChatMeta, MessageNode } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { toChatId, toMessageId, toToolCallId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { getChatBranchIterator } from '@/logic/chat-tree';
const state = vi.hoisted(() => ({
  chat: undefined as Chat | undefined, request: undefined as Parameters<LmProvider['chat']>[0] | undefined,
  progress: vi.fn(), save: vi.fn(), meta: vi.fn(), active: undefined as AbortController | undefined,
  generate: undefined as (() => AsyncIterable<ChatGenerationItem>) | undefined,
}));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  getLiveChatById: () => state.chat, getLiveChat: ({ chat }: { chat: Chat }) => chat,
  getReadonlyChat: () => state.chat, isProcessing: () => false, registerLiveInstance: vi.fn(),
  rootItems: { value: [] }, triggerCurrentChat: vi.fn(), updateChatContent: state.save, updateChatMeta: state.meta,
  chatRuntimeStore: { startTask: vi.fn(), finishTask: vi.fn() },
  contextCompactRuntime: { setProgress: state.progress, setActiveContextCompaction: ({ controller }: { controller: AbortController }) => {
    state.active = controller;
  },
  clearActiveContextCompaction: () => {
    state.active = undefined;
  }, getActiveContextCompaction: () => state.active },
}));
vi.mock('@/logic/context-compact', async importOriginal => {
  const actual = await importOriginal<typeof import('@/logic/context-compact')>();
  return { ...actual, createProviderForCompact: async () => ({ chat: (request: Parameters<LmProvider['chat']>[0]) => {
    state.request = request; return state.generate!();
  }, listModels: vi.fn() }) };
});
vi.mock('@/logic/chat-settings-resolver', () => ({ resolveChatSettings: () => ({ modelId: 'm', endpoint: { type: 'openai', url: 'https://example.invalid', httpHeaders: [] }, lmParameters: EMPTY_LM_PARAMETERS }) }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: { value: {} } }) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ addErrorEvent: vi.fn() }) }));
vi.mock('@/features/tools/composables/useChatWeshPreferences', () => ({ useChatWeshPreferences: () => ({ getNaidanSysfsAccessScope: () => 'none' }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { getFile: vi.fn() } }));
import { runCompactCurrentBranchForChat } from './chat-compact-flow';

function makeChat(): Chat {
  const tail: MessageNode = { id: toMessageId({ raw: 'last' }), role: 'assistant', createdAt: 3, modelId: 'm', lmParameters: undefined, interruption: { type: 'cancelled' }, parts: [{ id: 'p', type: 'text', text: '  old partial  ', completeness: 'partial' }], replies: { items: [] } };
  const second: MessageNode = { id: toMessageId({ raw: 'second' }), role: 'user', createdAt: 2, modelId: undefined, lmParameters: undefined, parts: [{ id: 'p', type: 'text', text: 'question', completeness: 'complete' }], replies: { items: [tail] } };
  const first: MessageNode = { id: toMessageId({ raw: 'first' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [{ id: 'p', type: 'text', text: 'original', completeness: 'complete' }], replies: { items: [second] } };
  return { id: toChatId({ raw: 'chat' }), title: 'chat', createdAt: 1, updatedAt: 1, debugEnabled: false, root: { items: [first] }, currentLeafId: tail.id };
}
async function* chunks({ values }: { values: string[] }) {
  yield* values;
}
function generate({ result }: { result: ChatGenerationResult }): AsyncIterable<ChatGenerationItem> {
  return (async function* () {
    yield { type: 'reasoning', partId: 'r', index: 0, chunks: chunks({ values: ['private summary reasoning'] }), completeness: Promise.resolve('complete' as const) };
    yield { type: 'text', partId: 't', index: 1, chunks: chunks({ values: ['  <think>literal</think>', 'summary  '] }), completeness: Promise.resolve(result.type === 'finished' ? 'complete' as const : 'partial' as const) };
    yield { type: 'result', result };
  })();
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); vi.clearAllMocks(); state.chat = makeChat(); state.active = undefined;
  state.generate = () => generate({ result: { type: 'finished', next: 'user' } }); state.request = undefined;
  state.save.mockImplementation(async ({ updater }: { updater: ({ current }: { current: ChatContent }) => ChatContent }) => updater({ current: state.chat! }));
  state.meta.mockImplementation(async ({ updater }: { updater: ({ current }: { current: ChatMeta }) => ChatMeta }) => updater({ current: state.chat! }));
});
describe('context compaction generation', () => {
  it('drains all children, stores raw summary text and preserves the source branch', async () => {
    const chat = state.chat!; const original = JSON.stringify(chat.root); const result = await runCompactCurrentBranchForChat({ chatId: chat.id, keepRecentMessages: 1, instructionOverride: undefined });
    expect(result.status).toBe('compacted'); expect(chat.root.items).toHaveLength(2);
    expect(JSON.stringify({ items: [chat.root.items[0]] })).toBe(original);
    expect(chat.root.items[1]!.parts).toEqual([{ id: 'text', type: 'text', text: '  <think>literal</think>summary  ', completeness: 'complete' }]);
    expect(chat.root.items[1]!.replies.items[0]).toMatchObject({ interruption: { type: 'cancelled' }, parts: [{ text: '  old partial  ', completeness: 'partial' }] });
    expect(state.request).toMatchObject({ tools: undefined, model: 'm', readBinaryObject: expect.any(Function) });
    expect(state.request?.messages[0]!.parts[0]).toMatchObject({ text: 'original' });
    expect(state.progress).toHaveBeenCalledWith(expect.objectContaining({ progress: expect.objectContaining({ phase: 'receiving_compact' }) }));
  });
  it('captures suffix before asynchronous generation instead of copying later UI edits', async () => {
    const chat = state.chat!; const suffix = Array.from(getChatBranchIterator({ chat })).at(-1)!;
    state.generate = () => {
      const p = suffix.parts[0]; if (p?.type === 'text') p.text = 'edited during request'; return generate({ result: { type: 'finished', next: 'user' } });
    };
    await runCompactCurrentBranchForChat({ chatId: chat.id, keepRecentMessages: 1, instructionOverride: undefined });
    expect(chat.root.items[1]!.replies.items[0]!.parts[0]).toMatchObject({ text: '  old partial  ' });
    expect(suffix.parts[0]).toMatchObject({ text: 'edited during request' });
  });
  it('does not install partial compaction after a length limit', async () => {
    state.generate = () => generate({ result: { type: 'interrupted', reason: 'limit' } }); const before = JSON.stringify(state.chat);
    await expect(runCompactCurrentBranchForChat({ chatId: state.chat!.id, keepRecentMessages: 1, instructionOverride: undefined })).rejects.toThrow('before completion');
    expect(JSON.stringify(state.chat)).toBe(before); expect(state.save).not.toHaveBeenCalled();
  });
  it('keeps accepted preview but does not install the branch after user cancellation', async () => {
    state.generate = () => (async function* () {
      yield* generate({ result: { type: 'interrupted', reason: 'aborted' } });
    })();
    const before = JSON.stringify(state.chat); const result = await runCompactCurrentBranchForChat({ chatId: state.chat!.id, keepRecentMessages: 1, instructionOverride: undefined });
    expect(result.status).toBe('aborted'); expect(JSON.stringify(state.chat)).toBe(before); expect(state.save).not.toHaveBeenCalled();
  });
  it('does not execute model-invented tools during compaction', async () => {
    state.generate = () => (async function* () {
      yield { type: 'tool_call', partId: 'c', index: 0, toolCall: { id: toToolCallId({ raw: 'c' }), type: 'function', function: { name: 'unexpected', arguments: '{}' } } }; yield { type: 'result', result: { type: 'finished', next: 'tool_results' } };
    })();
    await expect(runCompactCurrentBranchForChat({ chatId: state.chat!.id, keepRecentMessages: 1, instructionOverride: undefined })).rejects.toThrow('tool');
    expect(state.chat!.root.items).toHaveLength(1); expect(state.save).not.toHaveBeenCalled();
  });
  it('does not replace the old branch with an empty or failed summary', async () => {
    state.generate = () => (async function* () {
      yield { type: 'result', result: { type: 'error', error: new Error('network') } };
    })();
    await expect(runCompactCurrentBranchForChat({ chatId: state.chat!.id, keepRecentMessages: 1, instructionOverride: undefined })).rejects.toThrow('network');
    expect(state.chat!.root.items).toHaveLength(1); expect(state.save).not.toHaveBeenCalled();
  });
});
