import { computed, shallowRef, type Ref } from 'vue';
import type { ChatId, MessageId } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import type { ModelBindingSnapshot } from '@/00-storage/service/model-binding';
import { useSettings } from '@/composables/useSettings';
import { getLiveChatById, loadData, synchronizeModelBindingContent } from '@/composables/chat/global/chat-core-singletons';
import { captureChatModelBindingHistoryProof, withChatModelBindingFinalization, type ChatModelBindingHistoryProof } from '@/composables/chat/chat-scoped/chat-model-binding-operations';
import { promiseAllKeyed } from '@/utils/promise';
import { captureModelFileStorage, copyTemporaryModel, llamaCppBrowserModelFiles, waitForModelFileMutation, withSavedTemporaryModelFiles, type SavedTemporaryModel, type TemporaryModelSource } from '@/features/llama-cpp-browser/model-files';
import type { ModelLaunchDefaultSnapshot } from '@/features/llama-cpp-browser/model-launch/defaults';
import { errorCode, LlamaCppBrowserError, type ErrorCode, type LocalModel, type Progress } from '@/features/llama-cpp-browser/types';
import { beginLocalModelLaunchPromotion } from './local-model-launch-session';

export type TemporaryModelSaveNotice = Readonly<{
  phase: 'offered' | 'saving' | 'finalizing' | 'saved' | 'failed',
  model: LocalModel,
  progress: Progress | undefined,
  error: ErrorCode | undefined,
}>;
type SaveEntry = {
  chatId: ChatId,
  source: TemporaryModelSource,
  isStorageCurrent(): boolean,
  visibility: 'visible' | 'hidden',
  notice: TemporaryModelSaveNotice,
  saved: SavedTemporaryModel | undefined,
  expected: { chat: ModelBindingSnapshot | undefined, global: ModelLaunchDefaultSnapshot | undefined } | undefined,
  globalOutcome: 'applied' | 'changed' | 'not-targeted' | undefined,
  historyProof: ChatModelBindingHistoryProof | undefined,
  pending: Promise<void> | undefined,
};
const entries = shallowRef(new Map<ChatId, SaveEntry>());

function discardSavedCopy({ entry }: { entry: SaveEntry }): void {
  entry.historyProof?.release();
  entry.historyProof = undefined;
  entry.saved = undefined;
  entry.expected = undefined;
  entry.globalOutcome = undefined;
  entry.notice = { phase: 'failed', model: entry.source.model, progress: undefined, error: 'missing-model' };
}

function pruneEntries(): void {
  const current = new Map(entries.value);
  let modified = false;
  for (const [chatId, entry] of current) {
    if (entry.pending) {
      continue;
    }
    if (!entry.isStorageCurrent() || !entry.source.isCurrent()) {
      entry.historyProof?.release();
      current.delete(chatId);
      modified = true;
    } else if (entry.saved && !entry.saved.receipt.publication.isCurrent({ modelId: entry.saved.model.modelId })) {
      discardSavedCopy({ entry });
      modified = true;
    }
  }
  if (modified) {
    entries.value = current;
  }
}

llamaCppBrowserModelFiles.subscribeModelList({ listener: pruneEntries });

function changed({ entry }: { entry: SaveEntry }): void {
  if (entries.value.get(entry.chatId) === entry) {
    entries.value = new Map(entries.value);
  }
}

export function offerTemporaryModelSave({ chatId, source }: { chatId: ChatId, source: TemporaryModelSource }): void {
  pruneEntries();
  const previous = entries.value.get(chatId);
  if (previous?.source.model.modelId === source.model.modelId && previous.source.registrationRevision === source.registrationRevision) {
    return;
  }
  previous?.historyProof?.release();
  const isStorageCurrent = captureModelFileStorage();
  const entry: SaveEntry = {
    chatId,
    source,
    isStorageCurrent,
    visibility: 'visible',
    notice: { phase: 'offered', model: source.model, progress: undefined, error: undefined },
    saved: undefined,
    expected: undefined,
    globalOutcome: undefined,
    historyProof: undefined,
    pending: undefined,
  };
  entries.value = new Map(entries.value).set(chatId, entry);
}

async function saveEntry({ entry }: { entry: SaveEntry }): Promise<void> {
  const settings = useSettings();
  const controller = new AbortController();
  try {
    entry.notice = { ...entry.notice, phase: entry.saved ? 'finalizing' : 'saving', error: undefined };
    changed({ entry });
    if (!entry.expected) {
      entry.expected = await promiseAllKeyed({
        chat: storageService.captureModelBinding({ chatId: entry.chatId, sourceModelId: entry.source.model.modelId, isSourceCurrent: entry.source.isCurrent }),
        global: settings.captureGlobalModelBinding({ sourceModelId: entry.source.model.modelId }),
      });
      if (entry.expected.global) {
        const global = entry.expected.global;
        entry.expected.global = { ...global, isStorageCurrent: () => global.isStorageCurrent() && entry.source.isCurrent() };
      }
    }
    if (!entry.saved) {
      entry.saved = await copyTemporaryModel({
        source: entry.source,
        signal: controller.signal,
        onProgress: ({ progress }) => {
          entry.notice = { ...entry.notice, progress };
          changed({ entry });
        },
      });
    }
    entry.notice = { ...entry.notice, phase: 'finalizing' };
    changed({ entry });
    const saved = entry.saved;
    while (true) {
      const finalized = await withChatModelBindingFinalization({
        chatId: entry.chatId,
        operation: () => withSavedTemporaryModelFiles({
          source: entry.source,
          saved,
          signal: controller.signal,
          operation: async ({ model }) => {
            if (!entry.isStorageCurrent()) {
              return;
            }
            const synchronized = await synchronizeModelBindingContent({ chatId: entry.chatId });
            const current = getLiveChatById({ chatId: entry.chatId });
            const expectedContent = current === null ? undefined : storageService.createChatContentWrite({ id: entry.chatId, content: current, binding: undefined });
            const launchPromotion = beginLocalModelLaunchPromotion({
              chatId: entry.chatId,
              sourceModelId: entry.source.model.modelId,
              model,
              isCurrent: () => entry.isStorageCurrent() && saved.receipt.publication.isCurrent({ modelId: saved.model.modelId }),
            });
            try {
              switch (synchronized) {
              case 'synchronized':
                if (entry.historyProof === undefined) {
                  entry.historyProof = captureChatModelBindingHistoryProof({ chatId: entry.chatId, modelId: entry.source.model.modelId });
                  entry.historyProof.allowPromotion({ modelId: model.modelId });
                }
                break;
              case 'changed': break;
              default: {
                const exhaustive: never = synchronized;
                throw new Error(String(exhaustive));
              }
              }
              let globalFailure: { error: unknown } | undefined;
              if (entry.globalOutcome === undefined) {
                try {
                  entry.globalOutcome = entry.expected?.global
                    ? await settings.promoteGlobalModelBinding({ modelId: model.modelId, expected: entry.expected.global })
                    : 'not-targeted';
                } catch (error) {
                  // A global write failure does not veto independently matching
                  // owner/group scopes. Keep it retryable without copying again.
                  globalFailure = { error };
                }
              }
              switch (synchronized) {
              case 'changed': throw new Error('The chat contains unsaved changes');
              case 'synchronized': break;
              default: {
                const exhaustive: never = synchronized;
                throw new Error(String(exhaustive));
              }
              }
              if (entry.expected?.chat && expectedContent !== undefined && entry.source.isCurrent() && entry.isStorageCurrent()) {
                const historyProof = entry.historyProof?.isCurrent() ? entry.historyProof : undefined;
                await storageService.promoteModelBinding({
                  expected: entry.expected.chat,
                  modelId: model.modelId,
                  knownMessageIds: historyProof?.messageIds ?? [],
                  knownMessageFingerprints: historyProof?.fingerprints ?? new Map<MessageId, string>(),
                  expectedContent,
                  globalOutcome: entry.globalOutcome ?? 'changed',
                });
                await loadData();
                const result = await synchronizeModelBindingContent({ chatId: entry.chatId });
                switch (result) {
                case 'changed': throw new Error('The chat changed while saving the model binding');
                case 'synchronized': break;
                default: {
                  const exhaustive: never = result;
                  throw new Error(String(exhaustive));
                }
                }
              }
              if (globalFailure !== undefined) {
                throw globalFailure.error;
              }
            } finally {
              launchPromotion?.finish();
            }
          },
        }),
      });
      switch (finalized.status) {
      case 'busy':
        await waitForModelFileMutation({ signal: controller.signal });
        continue;
      case 'changed':
        discardSavedCopy({ entry });
        throw new LlamaCppBrowserError({ code: 'missing-model' });
      case 'completed': break;
      default: {
        const exhaustive: never = finalized;
        throw new Error(String(exhaustive));
      }
      }
      break;
    }
    entry.notice = { ...entry.notice, model: saved.model, phase: 'saved', error: undefined };
    entry.historyProof?.release();
    entry.historyProof = undefined;
  } catch (error) {
    entry.notice = { ...entry.notice, phase: 'failed', error: errorCode({ error }) };
  } finally {
    entry.pending = undefined;
    changed({ entry });
    pruneEntries();
  }
}

export function useTemporaryModelSave({ chatId }: { chatId: Readonly<Ref<ChatId | undefined>> }) {
  const settings = useSettings();
  const notice = computed(() => {
    void settings.settings.value;
    const entry = chatId.value === undefined ? undefined : entries.value.get(chatId.value);
    return entry?.visibility === 'visible' && entry.isStorageCurrent() && entry.source.isCurrent()
      && (!entry.saved || entry.saved.receipt.publication.isCurrent({ modelId: entry.saved.model.modelId })) ? { ...entry.notice, sourceModel: entry.source.model } : undefined;
  });
  async function save(): Promise<void> {
    pruneEntries();
    const entry = chatId.value === undefined ? undefined : entries.value.get(chatId.value);
    if (!entry || !entry.isStorageCurrent() || entry.notice.phase === 'saved') {
      return;
    }
    if (entry.pending) {
      return entry.pending;
    }
    entry.pending = Promise.resolve().then(() => saveEntry({ entry }));
    return entry.pending;
  }
  function dismiss(): void {
    const entry = chatId.value === undefined ? undefined : entries.value.get(chatId.value);
    if (entry) {
      entry.visibility = 'hidden';
      changed({ entry });
    }
  }
  return { notice, save, retry: save, dismiss, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export const TEST_ONLY = {
};
