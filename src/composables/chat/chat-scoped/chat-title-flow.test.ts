import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ChatGenerationItem, LmProvider } from '@/01-models/lm';
import { toChatId, toMessageId } from '@/01-models/ids';
import { DEFAULT_SETTINGS, type Chat, type Settings } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import { autoTitleScheduler } from '@/composables/chat/global/auto-title-runtime';
import {
  chatRuntimeStore, currentChatRef, getLiveChatById, liveChatRegistry,
  loadData, registerLiveInstance, rootItems, unregisterLiveInstance,
} from '@/composables/chat/global/chat-core-singletons';
import { abortTitleGenerationForChat, generateChatTitleForChat, scheduleAutoTitleForChat } from './chat-title-flow';

const { chatRequest } = vi.hoisted(() => ({ chatRequest: vi.fn<LmProvider['chat']>() }));
const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: 'https://example.test' }, defaultModelId: 'model' });
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings }) }));
vi.mock('@/features/lm/providerFactory', () => ({
  loadLmProvider: async (): Promise<LmProvider> => ({ chat: chatRequest, listModels: async () => ['model'] }),
}));

// Deliberately ignores abort, as a remote server or native runtime may do. The
// coordinator must release foreground work without trusting provider cleanup.
async function* titleItems({ text, ready }: { text: string, ready: Promise<void> }): AsyncGenerator<ChatGenerationItem> {
  await ready;
  yield { type: 'text', index: 0, partId: 'title', chunks: (async function* () {
    yield text;
  })(), completeness: Promise.resolve('complete') };
  yield { type: 'result', result: { type: 'finished', next: 'user' } };
}

async function savedChat({ name, selected }: { name: string, selected: boolean }): Promise<Chat> {
  const id = toChatId({ raw: name });
  const messageId = toMessageId({ raw: `${name}-user` });
  const chat: Chat = {
    id, title: null, createdAt: 1, updatedAt: 1, debugEnabled: false,
    currentLeafId: messageId,
    root: { items: [{ id: messageId, role: 'user', createdAt: 1, modelId: undefined, lmParameters: undefined,
      parts: [{ type: 'text', text: 'A conversation about testing', completeness: 'complete' }], replies: { items: [] } }] },
  };
  await storageService.updateChatMeta({ id, updater: () => chat });
  await storageService.updateChatContent({ id, updater: () => ({ root: chat.root, currentLeafId: messageId }) });
  await storageService.updateHierarchy({ updater: ({ current }) => ({ items: [...current.items, { type: 'chat', id }] }) });
  registerLiveInstance({ chat });
  if (selected) currentChatRef.value = getLiveChatById({ chatId: id });
  await loadData();
  const live = getLiveChatById({ chatId: id });
  if (live === null) throw new Error('Missing live chat');
  return live;
}

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  vi.useFakeTimers();
  autoTitleScheduler.reset();
  chatRuntimeStore.clearActiveGenerations();
  chatRuntimeStore.clearActiveTaskCounts();
  chatRuntimeStore.activeTitleGenerations.clear();
  chatRuntimeStore.externalGenerations.clear();
  currentChatRef.value = null;
  liveChatRegistry.clear();
  rootItems.value = [];
  await storageService.init({ type: 'memory' });
  settings.value = { ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: { type: 'openai', url: 'https://example.test' }, defaultModelId: 'model' };
  chatRequest.mockReset().mockImplementation(() => titleItems({ text: 'Generated Title', ready: Promise.resolve() }));
});
afterEach(async () => {
  autoTitleScheduler.reset();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('title lifecycle with real memory persistence', () => {
  it('keeps both processing and title indicators off during quiet time, then persists a title', async () => {
    const chat = await savedChat({ name: 'quiet', selected: true });
    scheduleAutoTitleForChat({ chatId: chat.id });
    await vi.advanceTimersByTimeAsync(2499);
    expect(chatRequest).not.toHaveBeenCalled();
    expect(chatRuntimeStore.isProcessing({ chatId: chat.id })).toBe(false);
    expect(chatRuntimeStore.isGeneratingTitle({ chatId: chat.id })).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(chatRequest).toHaveBeenCalledTimes(1);
    expect((await storageService.loadChat({ id: chat.id }))?.title).toBe('Generated Title');
    expect(chat.title).toBe('Generated Title');
    expect(chatRuntimeStore.isGeneratingTitle({ chatId: chat.id })).toBe(false);
  });

  it('aborts for another chat before foreground work queues and rejects an abort-ignoring result', async () => {
    const chat = await savedChat({ name: 'preempt', selected: true });
    const ready = Promise.withResolvers<void>();
    chatRequest.mockImplementationOnce(() => titleItems({ text: 'Stale Title', ready: ready.promise }));
    scheduleAutoTitleForChat({ chatId: chat.id });
    await vi.advanceTimersByTimeAsync(2500);
    const signal = chatRequest.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    const key = { kind: 'process' as const, chatId: toChatId({ raw: 'another-chat' }) };
    chatRuntimeStore.startTask({ key });
    expect(signal?.aborted).toBe(true);
    expect(chatRuntimeStore.isProcessing({ chatId: chat.id })).toBe(false);
    ready.resolve();
    await vi.advanceTimersByTimeAsync(10000);
    expect((await storageService.loadChat({ id: chat.id }))?.title).toBeNull();
    expect(chatRequest).toHaveBeenCalledTimes(1);
    chatRuntimeStore.finishTask({ key });
    await vi.advanceTimersByTimeAsync(2500);
    expect(chatRequest).toHaveBeenCalledTimes(2);
    expect((await storageService.loadChat({ id: chat.id }))?.title).toBe('Generated Title');
  });

  it('also postpones titles for external generation notifications', async () => {
    const chat = await savedChat({ name: 'external', selected: true });
    const other = toChatId({ raw: 'external-chat' });
    chatRuntimeStore.setExternalGeneration({ chatId: other });
    scheduleAutoTitleForChat({ chatId: chat.id });
    await vi.advanceTimersByTimeAsync(10000);
    expect(chatRequest).not.toHaveBeenCalled();
    chatRuntimeStore.deleteExternalGeneration({ chatId: other });
    await vi.advanceTimersByTimeAsync(2500);
    expect(chatRequest).toHaveBeenCalledTimes(1);
  });

  it('rehydrates a pending background chat after it leaves the live registry', async () => {
    const chat = await savedChat({ name: 'background', selected: false });
    scheduleAutoTitleForChat({ chatId: chat.id });
    unregisterLiveInstance({ chatId: chat.id });
    expect(getLiveChatById({ chatId: chat.id })).toBeNull();
    await vi.advanceTimersByTimeAsync(2500);
    expect((await storageService.loadChat({ id: chat.id }))?.title).toBe('Generated Title');
    expect(getLiveChatById({ chatId: chat.id })).toBeNull();
  });

  it('does not start work for a chat removed from the hierarchy during its undo window', async () => {
    const chat = await savedChat({ name: 'undo-window', selected: true });
    await storageService.updateHierarchy({ updater: () => ({ items: [] }) });
    // Simulate its last response finishing after the delete action.
    scheduleAutoTitleForChat({ chatId: chat.id });
    await vi.advanceTimersByTimeAsync(2500);
    expect(chatRequest).not.toHaveBeenCalled();
    expect((await storageService.loadChat({ id: chat.id }))?.title).toBeNull();
  });

  it.each(['rename', 'delete'] as const)('does not overwrite persisted %s even with stale live metadata', async action => {
    const chat = await savedChat({ name: action, selected: true });
    const ready = Promise.withResolvers<void>();
    chatRequest.mockImplementationOnce(() => titleItems({ text: 'Stale Title', ready: ready.promise }));
    scheduleAutoTitleForChat({ chatId: chat.id });
    await vi.advanceTimersByTimeAsync(2500);
    if (action === 'rename') {
      await storageService.updateChatMeta({ id: chat.id, updater: ({ current }) => current === null ? undefined : { ...current, title: 'Manual Title' } });
    } else {
      await storageService.deleteChat({ id: chat.id });
    }
    expect(chat.title).toBeNull();
    ready.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const persisted = await storageService.loadChat({ id: chat.id });
    if (action === 'rename') expect(persisted?.title).toBe('Manual Title');
    else expect(persisted).toBeNull();
    expect(chatRuntimeStore.isGeneratingTitle({ chatId: chat.id })).toBe(false);
  });

  it.each(['branch', 'settings'] as const)('discards a result after %s changes', async change => {
    const chat = await savedChat({ name: change, selected: true });
    const ready = Promise.withResolvers<void>();
    chatRequest.mockImplementationOnce(() => titleItems({ text: 'Stale Title', ready: ready.promise }));
    scheduleAutoTitleForChat({ chatId: chat.id });
    await vi.advanceTimersByTimeAsync(2500);
    if (change === 'branch') chat.currentLeafId = toMessageId({ raw: 'different-branch' });
    else settings.value.titleGeneration = 'disabled';
    ready.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect((await storageService.loadChat({ id: chat.id }))?.title).toBeNull();
  });

  it('rechecks disabled settings before starting a pending title', async () => {
    const chat = await savedChat({ name: 'disabled', selected: true });
    scheduleAutoTitleForChat({ chatId: chat.id });
    settings.value.titleGeneration = 'disabled';
    await vi.advanceTimersByTimeAsync(2500);
    expect(chatRequest).not.toHaveBeenCalled();
    expect(chatRuntimeStore.isGeneratingTitle({ chatId: chat.id })).toBe(false);
  });

  it('allows an explicit title request immediately and replaces its pending automatic job', async () => {
    const chat = await savedChat({ name: 'manual', selected: true });
    scheduleAutoTitleForChat({ chatId: chat.id });
    expect(await generateChatTitleForChat({ chatId: chat.id, signal: undefined, titleModelIdOverride: 'title-model' })).toBe('Generated Title');
    await vi.advanceTimersByTimeAsync(10000);
    expect(chatRequest).toHaveBeenCalledTimes(1);
    expect(chatRequest.mock.calls[0]?.[0].model).toBe('title-model');
  });

  it('explicit cancellation removes a pending job instead of retrying it', async () => {
    const chat = await savedChat({ name: 'cancelled', selected: true });
    scheduleAutoTitleForChat({ chatId: chat.id });
    abortTitleGenerationForChat({ chatId: chat.id });
    await vi.advanceTimersByTimeAsync(10000);
    expect(chatRequest).not.toHaveBeenCalled();
  });

  it('isolates an automatic failure and does not repeatedly retry it while idle', async () => {
    const chat = await savedChat({ name: 'failure', selected: true });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chatRequest.mockImplementation(async function* () {
      yield { type: 'result', result: { type: 'error', error: new Error('Offline') } };
    });
    scheduleAutoTitleForChat({ chatId: chat.id });
    await vi.advanceTimersByTimeAsync(10000);
    expect(chatRequest).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledOnce();
    expect(chatRuntimeStore.isProcessing({ chatId: chat.id })).toBe(false);
    expect(chatRuntimeStore.isGeneratingTitle({ chatId: chat.id })).toBe(false);
    expect((await storageService.loadChat({ id: chat.id }))?.title).toBeNull();
  });
});
