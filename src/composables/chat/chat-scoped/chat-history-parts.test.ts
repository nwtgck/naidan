import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import type { AssistantMessageNode, Chat, ChatContent, ChatMeta, Hierarchy, MessageNode } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { toAttachmentId, toBinaryObjectId, toChatId, toMessageId, toToolCallId, type ChatId } from '@/01-models/ids';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { getChatBranchIterator } from '@/logic/chat-tree';
import { createChatMessageSnapshot } from '@/01-models/chat-message';

const state = vi.hoisted(() => ({ current: undefined as Chat | undefined, fork: undefined as Chat | undefined,
  stored: new Map<ChatId, ChatContent>(), save: vi.fn(), metadata: vi.fn(), sent: vi.fn(), opened: vi.fn(), abort: vi.fn(), processing: false, persistBinary: false, saveFile: vi.fn(),
}));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  getLiveChatById: ({ chatId }: { chatId: ChatId }) => state.current?.id === chatId ? state.current : null,
  getLiveChat: ({ chat }: { chat: Chat }) => chat,
  isProcessing: () => state.processing,
  registerLiveInstance: ({ chat }: { chat: Chat }) => {
    state.fork = chat;
  },
  triggerCurrentChat: vi.fn(), loadData: vi.fn(), updateChatContent: state.save, updateChatMeta: state.metadata,
}));
vi.mock('@/composables/chat/chat-scoped/chat-generation-flow', () => ({ sendMessageToTargetChat: state.sent }));
vi.mock('@/composables/chat/chat-scoped/chat-processing-abort', () => ({ abortProcessingForChat: () => {
  state.abort(); state.processing = false;
} }));
vi.mock('@/composables/chat/ui/useChatNavigation', () => ({ useChatNavigation: () => ({ openChat: state.opened }) }));
vi.mock('@/00-storage/service', () => ({ storageService: { get canPersistBinary() {
  return state.persistBinary;
}, saveFile: state.saveFile, updateHierarchy: async ({ updater }: { updater: ({ current }: { current: Hierarchy }) => Hierarchy }) => updater({ current: { items: [] } }) } }));
import { commitFullHistoryManipulationForChat, editMessageForChat, forkChatForChat, switchVersionForChat } from './chat-history-flow';

function fixture(): { chat: Chat, user: MessageNode, assistant: AssistantMessageNode } {
  const assistant: AssistantMessageNode = { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 2, modelId: 'm', lmParameters: { ...EMPTY_LM_PARAMETERS, stop: ['STOP'], reasoning: { effort: 'high' } }, interruption: { type: 'error', message: '記録済みの理由' }, parts: [
    { type: 'reasoning', text: '  R\n', completeness: 'complete' },
    { type: 'text', text: '<think>literal</think>A ', completeness: 'partial' },
    { type: 'tool_call', toolCall: { id: toToolCallId({ raw: 'call' }), type: 'function', function: { name: 'f', arguments: '{ "n": 1 }' } } },
  ], replies: { items: [] } };
  const user: MessageNode = { id: toMessageId({ raw: 'u' }), role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined, parts: [{ type: 'text', text: 'question', completeness: 'complete' }], replies: { items: [assistant] } };
  const chat = reactive<Chat>({ id: toChatId({ raw: 'chat' }), title: 'Original', root: { items: [user] }, currentLeafId: assistant.id, createdAt: 1, updatedAt: 1, debugEnabled: false });
  state.current = chat;
  const actualUser = chat.root.items[0]!, actualAssistant = actualUser.replies.items[0]!;
  if (actualAssistant.role !== 'assistant') throw new Error('Invalid fixture');
  return { chat, user: actualUser, assistant: actualAssistant };
}
beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' }); vi.clearAllMocks(); state.stored.clear(); state.fork = undefined; state.processing = false; state.persistBinary = false; state.saveFile.mockReset();
  state.save.mockImplementation(async ({ id, updater }: { id: ChatId, updater: ({ current }: { current: ChatContent | null }) => ChatContent }) => {
    const next = updater({ current: state.stored.get(id) ?? null }); state.stored.set(id, next); return next;
  });
  state.metadata.mockImplementation(async ({ updater }: { updater: ({ current }: { current: ChatMeta | null }) => ChatMeta }) => updater({ current: null }));
});

describe('parts history branches', () => {
  it('forks only the selected path with exact content, states, stable IDs and independent parts', async () => {
    const { chat, user, assistant } = fixture();
    user.replies.items.push({ ...assistant, id: toMessageId({ raw: 'other' }), parts: [], replies: { items: [] } });
    const before = Array.from(getChatBranchIterator({ chat })).map(node => createChatMessageSnapshot({ node }));
    const forkId = await forkChatForChat({ chatId: chat.id, messageId: assistant.id });
    expect(forkId).not.toBeNull(); const fork = state.fork!;
    expect(Array.from(getChatBranchIterator({ chat: fork })).map(node => createChatMessageSnapshot({ node }))).toEqual(before);
    const copied = fork.root.items[0]!.replies.items[0]!;
    expect(copied.createdAt).toBe(2); expect(copied.role === 'assistant' && copied.interruption).toEqual({ type: 'error', message: '記録済みの理由' });
    expect(fork.root.items[0]!.replies.items).toHaveLength(1);
    const part = copied.parts[1]; if (part?.type !== 'text') throw new Error('Missing body'); part.text = 'new';
    expect(assistant.parts[1]).toMatchObject({ text: '<think>literal</think>A ', completeness: 'partial' });
    expect(state.opened).toHaveBeenCalledWith({ chatId: fork.id, leafId: undefined });
  });
  it('manual assistant edits create a sibling without overwriting generated parts or descendants', async () => {
    const { chat, user, assistant } = fixture();
    const before = JSON.stringify(assistant);
    const edited = '<think>literal edit</think> B \n';
    await editMessageForChat({ chatId: chat.id, messageId: assistant.id, newContent: edited, lmParameters: undefined });
    expect(user.replies.items).toHaveLength(2); const copy = user.replies.items[1]!;
    expect(copy.id).not.toBe(assistant.id); expect(copy.parts).toEqual([{ type: 'text', text: edited, completeness: 'complete' }]);
    expect(copy.role === 'assistant' && copy.interruption).toBeUndefined();
    expect(JSON.stringify(assistant)).toBe(before);
    expect(chat.currentLeafId).toBe(copy.id);
    if (copy.lmParameters?.stop) copy.lmParameters.stop.push('changed');
    expect(assistant.lmParameters?.stop).toEqual(['STOP']);
  });
  it('user resend forwards attachment parts and chosen parameters', async () => {
    const { chat, user } = fixture(); if (user.role !== 'user') throw new Error('Wrong user');
    const attachment = { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'f', size: 1, mimeType: 'image/png', uploadedAt: 1, status: 'memory' as const, blob: new Blob(['x']) };
    user.parts.push({ type: 'attachment', attachment });
    const parameters = { ...EMPTY_LM_PARAMETERS, reasoning: { effort: 'low' as const } };
    await editMessageForChat({ chatId: chat.id, messageId: user.id, newContent: 'new', lmParameters: parameters });
    expect(state.sent).toHaveBeenCalledWith({ targetChat: chat, content: 'new', parentId: null, attachments: [attachment], lmParameters: parameters });
  });
  it('switching versions preserves original interruption and partial parts', async () => {
    const { chat, user, assistant } = fixture(); const original = JSON.stringify(assistant);
    await editMessageForChat({ chatId: chat.id, messageId: assistant.id, newContent: 'replacement', lmParameters: undefined });
    expect(user.replies.items).toHaveLength(2);
    await switchVersionForChat({ chatId: chat.id, messageId: assistant.id });
    expect(chat.currentLeafId).toBe(assistant.id); expect(JSON.stringify(assistant)).toBe(original);
  });
  it('waits for generation ownership to end before creating an edited branch', async () => {
    const { chat, assistant } = fixture(); state.processing = true;
    await editMessageForChat({ chatId: chat.id, messageId: assistant.id, newContent: 'replacement', lmParameters: undefined });
    expect(state.abort).toHaveBeenCalledOnce(); expect(state.processing).toBe(false);
    expect(chat.currentLeafId).not.toBe(assistant.id);
  });
  it('commits an entire parts path without flattening tool results or rewriting original nodes', async () => {
    const { chat, user, assistant } = fixture();
    const tool: MessageNode = { id: toMessageId({ raw: 'tool' }), role: 'tool', createdAt: 3, modelId: undefined, lmParameters: undefined, parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: 'call' }), status: 'success', content: { type: 'text', text: '  observed\n' } } }], replies: { items: [] } };
    assistant.replies.items.push(tool);
    const original = JSON.stringify(chat.root.items);
    const prompt = { behavior: 'append', content: '  instructions\n' } as const;
    await commitFullHistoryManipulationForChat({ chatId: chat.id, messages: [user, assistant, tool], systemPrompt: prompt });
    expect(chat.root.items).toHaveLength(2);
    expect(JSON.stringify([chat.root.items[0]])).toBe(original);
    const copiedUser = chat.root.items[1]!; const copiedAssistant = copiedUser.replies.items[0]!; const copiedTool = copiedAssistant.replies.items[0]!;
    expect(copiedAssistant.parts).toEqual(assistant.parts);
    expect(copiedAssistant).toMatchObject({ createdAt: 2, interruption: { type: 'error', message: '記録済みの理由' } });
    expect(copiedTool.parts).toEqual(tool.parts); expect(chat.currentLeafId).toBe(copiedTool.id);
    expect(state.stored.get(chat.id)!.root).toBe(chat.root);
    const updater = state.metadata.mock.calls.at(-1)![0].updater;
    expect(updater({ current: { ...chat, systemPrompt: undefined } }).systemPrompt).toEqual(prompt);
  });
  it('freezes message and prompt snapshots before persisting a memory attachment', async () => {
    const { chat, user, assistant } = fixture();
    if (user.role !== 'user') throw new Error('Expected user');
    const attachment = { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'x.png', mimeType: 'image/png', size: 1, uploadedAt: 1, status: 'memory' as const, blob: new Blob(['x']) };
    user.parts.push({ type: 'attachment', attachment });
    state.persistBinary = true;
    let finish!: () => void;
    state.saveFile.mockImplementationOnce(() => new Promise<void>(resolve => {
      finish = resolve;
    }));
    const prompt = { behavior: 'append', content: 'original' } as const;
    const mutablePrompt: { behavior: 'append'; content: string } = { ...prompt };
    const pending = commitFullHistoryManipulationForChat({ chatId: chat.id, messages: [user, assistant], systemPrompt: mutablePrompt });
    expect(state.saveFile).toHaveBeenCalledOnce();
    const body = user.parts[0]; if (body?.type !== 'text') throw new Error('Expected text'); body.text = 'later edit';
    mutablePrompt.content = 'later prompt'; attachment.originalName = 'later.png';
    finish(); await pending;
    const savedUser = chat.root.items[1]!;
    expect(savedUser.parts[0]).toMatchObject({ text: 'question' });
    const savedImage = savedUser.parts[1]; if (savedImage?.type !== 'attachment') throw new Error('Expected image');
    expect(savedImage.attachment).toMatchObject({ status: 'persisted', originalName: 'x.png' });
    expect(savedImage.attachment).not.toHaveProperty('blob');
    expect(attachment.status).toBe('memory'); expect(attachment.blob).toBeInstanceOf(Blob);
    expect(chat.systemPrompt).toEqual(prompt);
  });
  it('retains an unsaved attachment body if persistence fails', async () => {
    const { chat, user } = fixture(); if (user.role !== 'user') throw new Error('Expected user');
    const blob = new Blob(['original']);
    user.parts.push({ type: 'attachment', attachment: { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'x.png', mimeType: 'image/png', size: blob.size, uploadedAt: 1, status: 'memory', blob } });
    state.persistBinary = true; state.saveFile.mockRejectedValueOnce(new Error('disk full'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await commitFullHistoryManipulationForChat({ chatId: chat.id, messages: [user], systemPrompt: undefined });
      const copy = chat.root.items[1]!.parts[1];
      expect(copy).toMatchObject({ type: 'attachment', attachment: { status: 'memory', blob } });
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
  it('keeps the new branch in memory without rewriting original nodes when content save fails', async () => {
    const { chat, user } = fixture();
    state.save.mockRejectedValueOnce(new Error('content storage failure'));
    await expect(commitFullHistoryManipulationForChat({ chatId: chat.id, messages: [user], systemPrompt: undefined })).rejects.toThrow('content storage failure');
    expect(chat.root.items).toHaveLength(2); expect(chat.root.items[1]!.parts).toEqual(user.parts);
    expect(state.metadata).not.toHaveBeenCalled();
  });

  it('keeps an awaiting history commit bound to its original chat after navigation', async () => {
    const { chat, user } = fixture(); if (user.role !== 'user') throw new Error('Expected user');
    user.parts.push({ type: 'attachment', attachment: { id: toAttachmentId({ raw: 'a' }), binaryObjectId: toBinaryObjectId({ raw: 'b' }), originalName: 'x.png', mimeType: 'image/png', size: 1, uploadedAt: 1, status: 'memory', blob: new Blob(['x']) } });
    state.persistBinary = true;
    let finish!: () => void;
    state.saveFile.mockImplementationOnce(() => new Promise<void>(resolve => {
      finish = resolve;
    }));
    const pending = commitFullHistoryManipulationForChat({ chatId: chat.id, messages: [user], systemPrompt: undefined });
    const other: Chat = reactive({ ...chat, id: toChatId({ raw: 'other' }), root: { items: [] } });
    state.current = other;
    finish(); await pending;
    expect(chat.root.items).toHaveLength(2); expect(other.root.items).toHaveLength(0);
    expect(state.save.mock.calls[0]![0].id).toEqual(chat.id);
  });

});
