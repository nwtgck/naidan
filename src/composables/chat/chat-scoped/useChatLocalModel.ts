import { computed, onScopeDispose, shallowReactive, shallowRef, watch, type Ref } from 'vue';
import type { ChatId } from '@/01-models/ids';
import type { SettingsTitleGeneration } from '@/01-models/types';
import { cloneModelLaunchTarget, type ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { cloneDownloadDestination, type DownloadDestination } from '@/01-models/download';
import type { AuthorizeModelLaunchDestination } from '@/features/llama-cpp-browser/model-launch/entry-state';
import { retargetTitleGenerationToSameScope } from '@/01-models/title-generation';
import { storageService } from '@/00-storage/service';
import { getLiveChatById, rootItems, updateChatScopedSettings, updateEmptyChatScopedSettings } from '@/composables/chat/global/chat-core-singletons';
import { useSettings } from '@/composables/useSettings';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import { awaitInspection } from '@/logic/model-file-inspection/abort';
import { errorCode, LlamaCppBrowserError, type LocalModel, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import type { getDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { withChatModelBindingFinalization } from './chat-model-binding-operations';
import { chatLocalModelInputs, type ChatLocalModelInput, type ChatLocalModelOperation } from './chat-local-model-input';

export type { ChatLocalModelOperation } from './chat-local-model-input';
let sequence = 0;
const downloadQueue = shallowRef<ReturnType<typeof getDownloadQueue>>();

function contextFor({ chatId }: { chatId: ChatId }) {
  const chat = getLiveChatById({ chatId });
  if (chat === null) {
    return undefined;
  }
  const chatGroups = rootItems.value.flatMap(item => {
    switch (item.type) {
    case 'chat': return [];
    case 'chat_group': return [item.chatGroup];
    default: {
      const exhaustive: never = item;
      throw new Error(String(exhaustive));
    }
    }
  });
  return { chat, chatGroups, settings: useSettings().settings.value };
}

function titleFor({ chatId }: { chatId: ChatId }): SettingsTitleGeneration {
  const context = contextFor({ chatId });
  if (context === undefined) {
    throw new Error('Chat not found');
  }
  const resolved = resolveChatSettings({ chat: context.chat, groups: context.chatGroups, globalSettings: context.settings });
  if (resolved.titleGeneration === 'disabled') {
    return 'disabled';
  }
  const source = (() => {
    switch (resolved.sources.titleGeneration) {
    case 'chat': return context.chat.titleGeneration;
    case 'chat_group': return context.chatGroups.find(item => item.id === context.chat.groupId)?.titleGeneration;
    case 'global': return context.settings.titleGeneration;
    default: {
      const exhaustive: never = resolved.sources.titleGeneration;
      throw new Error(String(exhaustive));
    }
    }
  })();
  if (source === undefined || source === 'inherit') {
    throw new Error('Title settings unavailable');
  }
  return retargetTitleGenerationToSameScope({ source, model: 'same_scope' });
}

function current({ input }: { input: ChatLocalModelInput }): boolean {
  return chatLocalModelInputs.value.get(input.chatId) === input && !input.controller.signal.aborted && input.isStorageCurrent();
}

function assertCurrent({ input }: { input: ChatLocalModelInput }): void {
  if (!current({ input })) {
    throw new DOMException('Model selection cancelled', 'AbortError');
  }
}

function remove({ input }: { input: ChatLocalModelInput }): void {
  if (chatLocalModelInputs.value.get(input.chatId) === input) {
    const next = new Map(chatLocalModelInputs.value);
    next.delete(input.chatId);
    chatLocalModelInputs.value = next;
  }
}

async function applyModel({ input, model }: { input: ChatLocalModelInput, model: LocalModel }): Promise<void> {
  assertCurrent({ input });
  // A candidate is now explicitly chosen. Presentation can leave the picker
  // while inspection and the existing binding/session handoff finish.
  input.state.model = model;
  const { captureTemporaryModelSource } = await import('@/features/llama-cpp-browser/model-files');
  const { inspectLocalModel } = await import('@/features/llama-cpp-browser/model-recovery/availability');
  assertCurrent({ input });
  const availability = await inspectLocalModel({ modelId: model.modelId });
  switch (availability) {
  case 'available': break;
  case 'missing': case 'unreadable': throw new LlamaCppBrowserError({ code: 'missing-model' });
  default: {
    const exhaustive: never = availability;
    throw new Error(String(exhaustive));
  }
  }
  const source = model.modelId.startsWith('temp/') ? await captureTemporaryModelSource({ modelId: model.modelId, signal: input.controller.signal }) : undefined;
  const { suspendLocalModelLaunchPreparation } = await import('@/features/llama-cpp-browser/composables/useLocalModelLaunchChat');
  const { registerLocalModelLaunchSession } = await import('@/features/llama-cpp-browser/composables/local-model-launch-session');
  const { offerTemporaryModelSave } = await import('@/features/llama-cpp-browser/composables/useTemporaryModelSave');
  await withChatModelBindingFinalization({
    chatId: input.chatId,
    operation: async () => {
      assertCurrent({ input });
      if (source?.isCurrent() === false) {
        throw new LlamaCppBrowserError({ code: 'missing-model' });
      }
      // Once accepted, ordinary settings persistence completes even if its view leaves.
      input.state.phase = 'committing';
      input.state.model = model;
      await suspendLocalModelLaunchPreparation({ chatId: input.chatId });
      const changes = [
        { field: 'endpoint', behavior: 'override', value: { type: 'llama_cpp_browser' } },
        { field: 'model_id', behavior: 'override', value: model.modelId },
      ] as const;
      const isCurrent = () => input.isStorageCurrent() && (source?.isCurrent() ?? true);
      switch (input.binding) {
      case 'chat':
        // An explicit selection replaces only this chat's endpoint and model.
        // History, title settings, the chat group and global defaults stay intact.
        await updateChatScopedSettings({ chatId: input.chatId, changes, isCurrent });
        break;
      case 'empty-chat': {
        const applied = await updateEmptyChatScopedSettings({
          chatId: input.chatId,
          changes: [...changes, { field: 'title_generation', behavior: 'override', value: titleFor({ chatId: input.chatId }) }],
          isCurrent,
        });
        if (!applied) {
          assertCurrent({ input });
          if (source?.isCurrent() === false) {
            throw new LlamaCppBrowserError({ code: 'missing-model' });
          }
          input.state.error = 'not-empty';
          throw new Error('The chat is missing or contains messages');
        }
        break;
      }
      default: {
        const exhaustive: never = input.binding;
        throw new Error(String(exhaustive));
      }
      }
      const context = contextFor({ chatId: input.chatId });
      if (context !== undefined && input.isStorageCurrent()) {
        registerLocalModelLaunchSession({
          chat: context.chat,
          model,
          homeOriginId: undefined,
          isCurrent: () => input.isStorageCurrent() && (source?.isCurrent() ?? true),
          readBinding: () => {
            const latest = contextFor({ chatId: input.chatId }) ?? context;
            const resolved = resolveChatSettings({ chat: latest.chat, groups: latest.chatGroups, globalSettings: latest.settings });
            return { chatGroupId: latest.chat.groupId, endpoint: resolved.endpoint, modelId: resolved.modelId };
          },
        });
        if (source !== undefined) {
          offerTemporaryModelSave({ chatId: input.chatId, source, chatGroupId: undefined });
        }
      }
      remove({ input });
    },
  });
}

async function run({ input }: { input: ChatLocalModelInput }): Promise<void> {
  // Start inside the explicit action so host permission requests precede any
  // lazy imports. The async boundary still catches synchronous failures.
  const pending = (async () => input.run())().catch(error => {
    if (current({ input })) {
      input.state.error ??= errorCode({ error });
      input.state.phase = 'error';
    }
  }).finally(() => {
    input.pending = undefined;
    if (input.controller.signal.aborted || !input.isStorageCurrent()) {
      remove({ input });
    }
  });
  input.pending = pending;
  await pending;
}

export function useChatLocalModel({ chatId, binding }: { chatId: Readonly<Ref<ChatId>>, binding: 'empty-chat' | 'chat' }) {
  const owner = {};
  function begin({ controller }: { controller: AbortController }): ChatLocalModelInput | undefined {
    const context = contextFor({ chatId: chatId.value });
    if (context === undefined || (binding === 'empty-chat' && context.chat.root.items.length !== 0) || controller.signal.aborted || chatLocalModelInputs.value.has(chatId.value)) {
      controller.abort();
      return undefined;
    }
    const input: ChatLocalModelInput = {
      chatId: chatId.value,
      owner,
      binding,
      controller,
      isStorageCurrent: storageService.captureSettingsStorage(),
      pending: undefined,
      run: async () => {},
      state: shallowReactive<ChatLocalModelOperation>({ id: ++sequence, phase: 'reading', candidates: [], model: undefined, error: undefined, downloadJobId: undefined }),
    };
    chatLocalModelInputs.value = new Map(chatLocalModelInputs.value).set(input.chatId, input);
    return input;
  }
  async function cancelInput({ input }: { input: ChatLocalModelInput }): Promise<void> {
    const phase = input.state.phase;
    switch (phase) {
    case 'committing': return;
    case 'reading': case 'choosing': case 'downloading': case 'cancelling': case 'error': break;
    default: {
      const exhaustive: never = phase;
      throw new Error(String(exhaustive));
    }
    }
    input.state.phase = 'cancelling';
    input.controller.abort();
    await input.pending;
    remove({ input });
  }
  function cancelOwned(): void {
    for (const input of chatLocalModelInputs.value.values()) {
      if (input.owner === owner) {
        void cancelInput({ input });
      }
    }
  }
  onScopeDispose(cancelOwned);
  watch(chatId, cancelOwned, { flush: 'sync' });

  function accept({ directories, controller }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController }): Promise<void> {
    void directories.catch(() => {});
    const input = begin({ controller });
    if (input === undefined) {
      return Promise.resolve();
    }
    input.run = async () => {
      const inputs = await awaitInspection({ task: directories, signal: input.controller.signal });
      const { importLocalModelDirectories } = await import('@/features/llama-cpp-browser/logic/local-model-input');
      if (input.state.candidates.length === 0) {
        input.state.candidates = await importLocalModelDirectories({ directories: inputs, signal: input.controller.signal });
      }
      assertCurrent({ input });
      const only = input.state.candidates.length === 1 ? input.state.candidates[0] : undefined;
      if (only === undefined) {
        input.state.phase = 'choosing';
      } else {
        await applyModel({ input, model: only });
      }
    };
    return run({ input });
  }
  function choose({ modelId }: { modelId: string }): Promise<void> {
    const input = chatLocalModelInputs.value.get(chatId.value);
    const model = input?.state.candidates.find(candidate => candidate.modelId === modelId);
    if (input === undefined || input.pending !== undefined || model === undefined) {
      return Promise.resolve();
    }
    input.run = () => applyModel({ input, model });
    return run({ input });
  }
  function useModel({ model }: { model: LocalModel }): Promise<void> {
    const input = begin({ controller: new AbortController() });
    if (input === undefined) {
      return Promise.resolve();
    }
    input.run = () => applyModel({ input, model });
    return run({ input });
  }
  function useRepositoryModel({ target, destination, authorizeDestination }: { target: ModelLaunchTarget, destination: DownloadDestination, authorizeDestination: AuthorizeModelLaunchDestination | undefined }): Promise<void> {
    const input = begin({ controller: new AbortController() });
    if (input === undefined) {
      return Promise.resolve();
    }
    const requestedTarget = cloneModelLaunchTarget({ target });
    const requestedDestination = cloneDownloadDestination({ destination });
    input.run = async () => {
      assertCurrent({ input });
      if (requestedDestination.kind === 'host' && authorizeDestination === undefined) {
        throw new LlamaCppBrowserError({ code: 'storage-error' });
      }
      // Invoke before awaiting/importing; retry is another explicit action and
      // must obtain fresh permission for this captured destination as well.
      const authorization = authorizeDestination?.({ destination: requestedDestination });
      const authorized = authorization === undefined ? { destination: requestedDestination, expectedRoot: undefined }
        : await awaitInspection({ task: authorization, signal: input.controller.signal });
      assertCurrent({ input });
      const { installedSelection } = await import('@/features/llama-cpp-browser/hugging-face/storage');
      assertCurrent({ input });
      let model = await installedSelection({ selection: requestedTarget.selection, destination: authorized.destination, expectedRoot: authorized.expectedRoot });
      assertCurrent({ input });
      if (model === undefined) {
        const { getDownloadQueue } = await import('@/features/llama-cpp-browser/hugging-face/download-queue');
        const { selectionKey } = await import('@/features/llama-cpp-browser/hugging-face/download-plan');
        const queue = getDownloadQueue();
        downloadQueue.value = queue;
        assertCurrent({ input });
        const download = queue.enqueue({ key: selectionKey({ selection: requestedTarget.selection }), repository: requestedTarget.selection.repository, source: 'repository', destination: authorized.destination, expectedRoot: authorized.expectedRoot, prepare: async () => requestedTarget.selection });
        input.state.downloadJobId = download.id;
        input.state.phase = 'downloading';
        const result = await awaitInspection({ task: download.done, signal: input.controller.signal });
        assertCurrent({ input });
        switch (result.status) {
        case 'complete': break;
        case 'queued': case 'resolving': case 'downloading': case 'pausing': case 'paused': case 'failed': case 'cancelled': throw new LlamaCppBrowserError({ code: 'storage-error' });
        default: {
          const exhaustive: never = result.status;
          throw new Error(String(exhaustive));
        }
        }
        model = await installedSelection({ selection: requestedTarget.selection, destination: authorized.destination, expectedRoot: authorized.expectedRoot });
      }
      assertCurrent({ input });
      if (model === undefined) {
        throw new LlamaCppBrowserError({ code: 'missing-model' });
      }
      await applyModel({ input, model });
    };
    return run({ input });
  }
  async function retry(): Promise<void> {
    const input = chatLocalModelInputs.value.get(chatId.value);
    if (input === undefined || input.pending !== undefined) {
      return;
    }
    input.state.error = undefined;
    input.state.phase = 'reading';
    await run({ input });
  }
  async function cancel(): Promise<void> {
    const input = chatLocalModelInputs.value.get(chatId.value);
    if (input !== undefined) {
      await cancelInput({ input });
    }
  }
  function pauseDownload(): void {
    const id = chatLocalModelInputs.value.get(chatId.value)?.state.downloadJobId;
    if (id !== undefined) {
      downloadQueue.value?.cancel({ id });
    }
  }
  const operation = computed(() => chatLocalModelInputs.value.get(chatId.value)?.state);
  const downloadJob = computed(() => downloadQueue.value?.jobs.value.find(job => job.id === operation.value?.downloadJobId));
  return { operation, downloadJob, maySend: computed(() => !chatLocalModelInputs.value.has(chatId.value)), accept, choose, useModel, useRepositoryModel, retry, cancel, pauseDownload, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

export type ChatLocalModelUi = ReturnType<typeof useChatLocalModel>;
export const TEST_ONLY = {
};
