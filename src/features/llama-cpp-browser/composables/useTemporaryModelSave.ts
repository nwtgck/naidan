import { computed, shallowReactive, shallowRef, type Ref } from 'vue';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import { replaceAssistantModelReferences } from '@/01-models/chat-message';
import { storageService } from '@/00-storage/service';
import { useSettings } from '@/composables/useSettings';
import { getLiveChatById, loadData, rootItems, synchronizeModelBindingContent, updateChatScopedSettings } from '@/composables/chat/global/chat-core-singletons';
import { withChatModelBindingFinalization } from '@/composables/chat/chat-scoped/chat-model-binding-operations';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import { cancelLocalRepositorySave, localRepositorySaveState, saveLocalRepository, subscribeLocalRepositorySaves, captureModelFileStorage, copyTemporaryModel, llamaCppBrowserModelFiles, waitForModelFileMutation, withSavedTemporaryModelFiles, type SavedTemporaryModel, type TemporaryModelSource } from '@/features/llama-cpp-browser/model-files';
import { localRepositories } from '@/features/llama-cpp-browser/runtime/local-repository-store';
import { errorCode, LlamaCppBrowserError, type ErrorCode, type LocalModel, type Progress } from '@/features/llama-cpp-browser/types';
import { localModelLaunchSession, registerLocalModelLaunchSession } from './local-model-launch-session';
import { suspendLocalModelLaunchPreparation } from './useLocalModelLaunchChat';

export type TemporaryModelSaveNotice = Readonly<{
  phase: 'offered' | 'saving' | 'finalizing' | 'saved' | 'failed',
  model: LocalModel,
  progress: Progress | undefined,
  error: ErrorCode | undefined,
}>;
type SaveEntry = {
  chatId: ChatId,
  chatGroupId: ChatGroupId | undefined,
  source: TemporaryModelSource,
  isStorageCurrent(): boolean,
  visibility: 'visible' | 'hidden',
  notice: TemporaryModelSaveNotice,
  saved: SavedTemporaryModel | undefined,
  controller: AbortController | undefined,
  pending: Promise<void> | undefined,
};
const entries = shallowRef(new Map<ChatId, SaveEntry>());
const repositorySaveRevision = shallowRef(0);
subscribeLocalRepositorySaves({
  listener: () => {
    repositorySaveRevision.value++;
  },
});

function changed(): void {
  entries.value = new Map(entries.value);
}

function available({ entry }: { entry: SaveEntry }): boolean {
  return entry.isStorageCurrent() && (entry.saved === undefined ? entry.source.isCurrent() : entry.saved.receipt.publication.isCurrent({ modelId: entry.saved.model.modelId }));
}

function pruneEntries(): void {
  for (const [chatId, entry] of entries.value) {
    if (entry.pending === undefined && !available({ entry })) {
      entries.value.delete(chatId);
    }
  }
  changed();
}

llamaCppBrowserModelFiles.subscribeModelList({ listener: pruneEntries });

export function offerTemporaryModelSave({ chatId, source, chatGroupId }: { chatId: ChatId, source: TemporaryModelSource, chatGroupId: ChatGroupId | undefined }): void {
  pruneEntries();
  const previous = entries.value.get(chatId);
  if (previous?.pending !== undefined) {
    return;
  }
  if (previous?.source.model.modelId === source.model.modelId && previous.source.registrationRevision === source.registrationRevision) {
    // Selecting the original temporary model again is a new explicit action.
    // Reuse its completed copy instead of offering an unusable saved notice.
    const phase = previous.notice.phase;
    switch (phase) {
    case 'saved':
      previous.chatGroupId = chatGroupId;
      previous.visibility = 'visible';
      previous.notice = { phase: 'offered', model: source.model, progress: undefined, error: undefined };
      break;
    case 'offered': case 'saving': case 'finalizing': case 'failed': break;
    default: {
      const exhaustive: never = phase;
      throw new Error(String(exhaustive));
    }
    }
    return;
  }
  entries.value = new Map(entries.value).set(chatId, shallowReactive<SaveEntry>({
    chatId,
    chatGroupId,
    source,
    isStorageCurrent: captureModelFileStorage(),
    visibility: 'visible',
    notice: { phase: 'offered', model: source.model, progress: undefined, error: undefined },
    saved: undefined,
    controller: undefined,
    pending: undefined,
  }));
}

async function applySavedModel({ entry, saved }: { entry: SaveEntry, saved: SavedTemporaryModel }): Promise<void> {
  const model = saved.model;
  const isCurrent = () => entry.isStorageCurrent() && saved.receipt.publication.isCurrent({ modelId: model.modelId });
  const homeOriginId = localModelLaunchSession({ chatId: entry.chatId })?.homeOriginId;
  await suspendLocalModelLaunchPreparation({ chatId: entry.chatId });
  if (!isCurrent()) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  if (await storageService.loadChatMeta({ id: entry.chatId }) !== null) {
    // Save is an explicit choice for this chat. Patch only these fields against
    // current metadata, including when the old temp override was cleared.
    await updateChatScopedSettings({
      chatId: entry.chatId,
      isCurrent,
      changes: [
        { field: 'endpoint', behavior: 'override', value: { type: 'llama_cpp_browser' } },
        { field: 'model_id', behavior: 'override', value: model.modelId },
      ],
    });
    const content = await storageService.loadChatContent({ id: entry.chatId });
    if (content !== null && isCurrent()) {
      const write = storageService.createChatContentWrite({ id: entry.chatId, content, binding: undefined });
      await storageService.updateChatContent({
        id: entry.chatId,
        write,
        updater: ({ current }) => {
          if (current === null) {
            throw new Error('Chat content not found');
          }
          return { ...current, root: replaceAssistantModelReferences({ branch: current.root, sourceModelId: entry.source.model.modelId, modelId: model.modelId }) };
        },
      });
      await synchronizeModelBindingContent({ chatId: entry.chatId });
    }
    const chat = getLiveChatById({ chatId: entry.chatId });
    if (chat !== null && isCurrent()) {
      registerLocalModelLaunchSession({
        chat,
        model,
        homeOriginId,
        isCurrent,
        readBinding: () => {
          const groups = rootItems.value.flatMap(item => {
            switch (item.type) {
            case 'chat': return [];
            case 'chat_group': return [item.chatGroup];
            default: {
              const exhaustive: never = item;
              throw new Error(String(exhaustive));
            }
            }
          });
          const resolved = resolveChatSettings({ chat, groups, globalSettings: useSettings().settings.value });
          return { chatGroupId: chat.groupId, endpoint: resolved.endpoint, modelId: resolved.modelId };
        },
      });
    }
  }
  if (!isCurrent()) {
    return;
  }
  await useSettings().promoteTemporaryModelDefault({ sourceModelId: entry.source.model.modelId, modelId: model.modelId, isCurrent });
  if (entry.chatGroupId !== undefined) {
    await storageService.updateChatGroup({
      id: entry.chatGroupId,
      updater: ({ current }) => {
        if (!isCurrent() || current === null || current.endpoint?.type !== 'llama_cpp_browser' || current.modelId !== entry.source.model.modelId) {
          return undefined;
        }
        return { ...current, modelId: model.modelId };
      },
    });
    await loadData();
  }
}

async function saveEntry({ entry, controller }: { entry: SaveEntry, controller: AbortController }): Promise<void> {
  entry.notice = { ...entry.notice, phase: 'saving', error: undefined };
  changed();
  try {
    controller.signal.throwIfAborted();
    if (entry.saved === undefined) {
      entry.saved = await copyTemporaryModel({
        source: entry.source,
        signal: controller.signal,
        onProgress: ({ progress }) => {
          entry.notice = { ...entry.notice, progress };
          changed();
        },
      });
    }
    const saved = entry.saved;
    while (true) {
      controller.signal.throwIfAborted();
      const result = await withChatModelBindingFinalization({
        chatId: entry.chatId,
        operation: async () => {
          controller.signal.throwIfAborted();
          return withSavedTemporaryModelFiles({
            source: entry.source,
            saved,
            signal: controller.signal,
            operation: async () => {
              controller.signal.throwIfAborted();
              // Cancellation ends here, before ordinary settings persistence starts.
              entry.notice = { ...entry.notice, phase: 'finalizing' };
              changed();
              await applySavedModel({ entry, saved });
            },
          });
        },
      });
      switch (result.status) {
      case 'completed':
        entry.notice = { ...entry.notice, phase: 'saved', model: saved.model };
        return;
      case 'busy': await waitForModelFileMutation({ signal: controller.signal });
        break;
      case 'changed': throw new LlamaCppBrowserError({ code: 'missing-model' });
      default: {
        const exhaustive: never = result;
        throw new Error(String(exhaustive));
      }
      }
    }
  } catch (error) {
    entry.notice = controller.signal.aborted
      ? { ...entry.notice, phase: 'offered', progress: undefined, error: undefined }
      : { ...entry.notice, phase: 'failed', error: errorCode({ error }) };
  } finally {
    entry.controller = undefined;
    entry.pending = undefined;
    pruneEntries();
  }
}

export function useTemporaryModelSave({ chatId }: { chatId: Readonly<Ref<ChatId | undefined>> }) {
  const entry = computed(() => chatId.value === undefined ? undefined : entries.value.get(chatId.value));
  const state = computed(() => {
    void repositorySaveRevision.value;
    const current = entry.value;
    if (current?.source.localSource && available({ entry: current })) {
      const source = current.source.localSource;
      const saved = localRepositorySaveState({ source });
      const modelId = localRepositories.savedModelId({ modelId: current.source.model.modelId });
      const phase = saved.phase === 'saved' && modelId === current.source.model.modelId ? 'offered' : saved.phase;
      return { ...saved, phase, model: { ...current.source.model, modelId }, sourceModel: current.source.model };
    }
    return current !== undefined && available({ entry: current }) ? { ...current.notice, sourceModel: current.source.model } : undefined;
  });
  const notice = computed(() => {
    const visibility = entry.value?.visibility;
    switch (visibility) {
    case 'visible': return state.value;
    case 'hidden': case undefined: return undefined;
    default: {
      const exhaustive: never = visibility;
      throw new Error(String(exhaustive));
    }
    }
  });
  const hiddenNotice = computed(() => entry.value?.visibility === 'hidden' && (entry.value.pending !== undefined || (state.value?.phase === 'saving' || state.value?.phase === 'finalizing')) ? state.value : undefined);
  function save(): Promise<void> {
    const current = entry.value;
    if (current === undefined || !available({ entry: current }) || current.notice.phase === 'saved') {
      return Promise.resolve();
    }
    if (current.source.localSource) {
      return saveLocalRepository({ source: current.source.localSource });
    }
    if (current.pending === undefined) {
      const controller = new AbortController();
      current.controller = controller;
      current.pending = Promise.resolve().then(() => saveEntry({ entry: current, controller }));
    }
    return current.pending;
  }
  function dismiss(): void {
    if (entry.value) {
      entry.value.visibility = 'hidden';
      changed();
    }
  }
  function show(): void {
    pruneEntries();
    if (entry.value) {
      entry.value.visibility = 'visible';
      changed();
    }
  }
  async function cancel(): Promise<void> {
    const current = entry.value;
    if (current === undefined || current.notice.phase === 'finalizing') {
      return;
    }
    if (current.source.localSource) {
      cancelLocalRepositorySave({ source: current.source.localSource });
      return;
    }
    current.controller?.abort();
    await current.pending;
  }
  return { notice, hiddenNotice, save, retry: save, dismiss, show, cancel, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
