import { computed, onScopeDispose, reactive, readonly, shallowRef, toRaw, watch } from 'vue';
import { useRouter } from 'vue-router';
import { generateId } from '@/01-models/id';
import { idToRaw, type ChatGroupId, type ChatId } from '@/01-models/ids';
import type { SettingsTitleGeneration } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { handoffAppEntryToChat, useAppEntry, type ModelLaunchStartContext } from '@/composables/useAppEntry';
import { useSettings } from '@/composables/useSettings';
import { useToast } from '@/composables/useToast';
import { ensureStrings } from '@/strings';
import { loadData, registerLiveInstance, rootItems } from '@/composables/chat/global/chat-core-singletons';
import { resolveChatSettings } from '@/logic/chat-settings-resolver';
import { registerChatModelBindingOrigin } from '@/composables/chat/chat-scoped/chat-model-binding-operations';
import { localModelChatGroupName } from '@/features/llama-cpp-browser/chat-group-name';
import { captureTemporaryModelSource, llamaCppBrowserModelFiles, type TemporaryModelSource } from '@/features/llama-cpp-browser/model-files';
import { offerTemporaryModelSave } from '@/features/llama-cpp-browser/composables/useTemporaryModelSave';
import { retainLocalRepositorySource } from '@/features/llama-cpp-browser/local-repository-lifetime';
import { isPendingLocalModelReference } from '@/features/llama-cpp-browser/local-repository-reference';
import { registerLocalModelLaunchSession } from '@/features/llama-cpp-browser/composables/local-model-launch-session';
import type { ModelLaunchDefaultSnapshot } from '@/features/llama-cpp-browser/model-launch/defaults';
import { LlamaCppBrowserError, type LocalModel, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import type { LocalRepositoryLayoutChoice } from '@/features/llama-cpp-browser/runtime/local-repository-layout';

type LocalLaunchAttempt = {
  chatId: ChatId,
  chatGroupId: ChatGroupId,
  titleGeneration: SettingsTitleGeneration,
  isStorageCurrent(): boolean,
  promise: Promise<void> | undefined,
  source: TemporaryModelSource | undefined,
};
type LocalInputCandidate = { model: LocalModel, isCurrent(): boolean };
type LocalInputOperation = {
  controller: AbortController,
  context: ModelLaunchStartContext,
  isStorageCurrent(): boolean,
  defaults: Promise<ModelLaunchDefaultSnapshot | undefined>,
  candidates: LocalInputCandidate[],
  attempts: Map<string, LocalLaunchAttempt>,
};
type LocalInputSelection = {
  operation: LocalInputOperation,
  status: 'choosing' | 'starting',
  error: 'start-failed' | undefined,
} | {
  operation: LocalInputOperation,
  status: 'layout',
  rootName: string,
  choices: LocalRepositoryLayoutChoice[],
  chooseLayout({ layout }: { layout: LocalRepositoryLayoutChoice['layout'] }): void,
};
type LocalModelValidation = {
  isCurrent(): boolean,
  check({ refresh }: { refresh: 'if-needed' | 'now' }): Promise<void>,
};

const localInputSelection = shallowRef<LocalInputSelection>();
const inputPromises = new WeakMap<AbortController, Promise<void>>();
let activeInput: LocalInputOperation | undefined;

function currentInput({ operation }: { operation: LocalInputOperation }): boolean {
  return activeInput === operation && !operation.controller.signal.aborted && operation.context.isCurrent() && operation.isStorageCurrent();
}

function createAttempt(): LocalLaunchAttempt {
  return {
    chatId: generateId<ChatId>(),
    chatGroupId: generateId<ChatGroupId>(),
    titleGeneration: structuredClone(toRaw(useSettings().settings.value.titleGeneration)),
    isStorageCurrent: storageService.captureModelLaunchStorage(),
    promise: undefined,
    source: undefined,
  };
}

async function prepareLocalChat({ model, source, attempt, signal, isCurrent, defaults, navigate, homeOriginId, validation }: {
  model: LocalModel,
  source: TemporaryModelSource | undefined,
  attempt: LocalLaunchAttempt,
  signal: AbortSignal,
  isCurrent(): boolean,
  defaults: Promise<ModelLaunchDefaultSnapshot | undefined> | undefined,
  navigate({ chatPath }: { chatPath: string }): Promise<boolean>,
  homeOriginId: string | undefined,
  validation: LocalModelValidation,
}): Promise<void> {
  const uiCurrent = () => !signal.aborted && isCurrent() && attempt.isStorageCurrent();
  const current = () => uiCurrent() && (source === undefined || source.isCurrent()) && validation.isCurrent();
  const validate = async ({ refresh }: { refresh: 'if-needed' | 'now' }): Promise<void> => {
    if (!uiCurrent()) {
      return;
    }
    if (source !== undefined && !source.isCurrent()) {
      throw new Error('Local model files changed');
    }
    await validation.check({ refresh });
    if (uiCurrent() && source !== undefined && !source.isCurrent()) {
      throw new Error('Local model files changed');
    }
  };
  if (!uiCurrent()) {
    return;
  }
  const request = {
    chatId: attempt.chatId,
    chatGroupId: attempt.chatGroupId,
    modelId: model.modelId,
    chatGroupName: localModelChatGroupName({ model }),
    titleGeneration: attempt.titleGeneration,
  };
  const prepare = async () => {
    while (uiCurrent()) {
      await validate({ refresh: 'if-needed' });
      if (!uiCurrent()) {
        return undefined;
      }
      let waitingForValidation = false;
      try {
        return await storageService.prepareLocalModelChat({
          request,
          signal,
          isCurrent: () => {
            if (uiCurrent() && !validation.isCurrent()) {
              waitingForValidation = true;
            }
            return current();
          },
        });
      } catch (error) {
        if (!uiCurrent()) {
          return undefined;
        }
        await validate({ refresh: 'if-needed' });
        if (!waitingForValidation) {
          throw error;
        }
        // A notice may reach the synchronous storage guard while its selected
        // model read is pending. Re-enter only that unwritten reservation.
      }
    }
    return undefined;
  };
  const chat = await prepare();
  if (chat === undefined || !uiCurrent()) {
    return;
  }
  await validate({ refresh: 'if-needed' });
  if (!uiCurrent()) {
    return;
  }
  await loadData();
  await validate({ refresh: 'if-needed' });
  if (!uiCurrent()) {
    return;
  }
  registerLiveInstance({ chat });
  if (source !== undefined) {
    registerChatModelBindingOrigin({ chatId: chat.id, modelId: model.modelId, isCurrent: () => attempt.isStorageCurrent() && source.isCurrent() });
  }
  const live = reactive(chat);
  registerLocalModelLaunchSession({
    chat: live,
    model,
    homeOriginId,
    isCurrent: () => attempt.isStorageCurrent() && (source === undefined || source.isCurrent()),
    readBinding: () => {
      const resolved = resolveChatSettings({
        chat: live,
        groups: rootItems.value.flatMap(item => {
          switch (item.type) {
          case 'chat': return [];
          case 'chat_group': return [item.chatGroup];
          default: {
            const exhaustive: never = item;
            throw new Error(String(exhaustive));
          }
          }
        }),
        globalSettings: useSettings().settings.value,
      });
      return { chatGroupId: live.groupId, endpoint: resolved.endpoint, modelId: resolved.modelId };
    },
  });
  let defaultSaveFailed = false;
  if (defaults !== undefined) {
    try {
      const expected = await defaults;
      await validate({ refresh: 'if-needed' });
      if (!uiCurrent()) {
        return;
      }
      if (expected !== undefined) {
        await useSettings().initializeModelLaunchDefaults({ modelId: model.modelId, expected: { ...expected, isStorageCurrent: () => expected.isStorageCurrent() && current() } });
      }
    } catch {
      defaultSaveFailed = true;
    }
  }
  await validate({ refresh: 'now' });
  if (!uiCurrent()) {
    return;
  }
  const opened = await navigate({ chatPath: `/chat/${idToRaw({ id: chat.id })}` });
  if (!opened && current()) {
    throw new Error('Could not open the created chat');
  }
  if (opened && source !== undefined && attempt.isStorageCurrent() && source.isCurrent()) {
    offerTemporaryModelSave({ chatId: chat.id, source, chatGroupId: attempt.chatGroupId });
  }
  if (opened && defaultSaveFailed) {
    try {
      useToast().addToast({ message: await ensureStrings.useLocalModelStart__could_not_save_the_default_model_your_chat_is_ready(), duration: 5000 });
    } catch { /* A warning must not interrupt the saved chat handoff. */ }
  }
}

async function startInputCandidate({ operation, candidate }: { operation: LocalInputOperation, candidate: LocalInputCandidate }): Promise<void> {
  const sourcePin = retainLocalRepositorySource({ modelId: candidate.model.modelId });
  try {
    const current = () => currentInput({ operation });
    if (!current()) {
      return;
    }
    const validation: LocalModelValidation = {
      isCurrent: candidate.isCurrent,
      check: async () => {
        if (!candidate.isCurrent()) {
          throw new Error('Local model files changed');
        }
      },
    };
    await validation.check({ refresh: 'if-needed' });
    if (!current()) {
      return;
    }
    let attempt = operation.attempts.get(candidate.model.modelId);
    if (attempt === undefined || !attempt.isStorageCurrent()) {
      attempt = createAttempt();
      operation.attempts.set(candidate.model.modelId, attempt);
    }
    if (attempt.promise !== undefined) {
      return attempt.promise;
    }
    const selectedAttempt = attempt;
    const promise = (async () => {
      if (selectedAttempt.source !== undefined && !selectedAttempt.source.isCurrent()) {
        throw new Error('Local model files changed');
      }
      const source = selectedAttempt.source ?? await captureTemporaryModelSource({ modelId: candidate.model.modelId, signal: operation.controller.signal });
      selectedAttempt.source = source;
      if (!current()) {
        return;
      }
      await prepareLocalChat({
        model: source.model,
        source,
        attempt: selectedAttempt,
        signal: operation.controller.signal,
        isCurrent: current,
        defaults: operation.defaults,
        navigate: ({ chatPath }) => handoffAppEntryToChat({ context: operation.context, chatPath }),
        homeOriginId: operation.context.homeOriginId,
        validation,
      });
    })();
    selectedAttempt.promise = promise;
    try {
      await promise;
    } finally {
      selectedAttempt.promise = undefined;
    }
  } finally {
    sourcePin?.release();
  }
}

/** File/drop capture belongs to the synchronous caller, before this lazy module loads. */
async function confirmLocalInputLayout({ directory, operation }: {
  directory: ModelDirectoryInput, operation: LocalInputOperation,
}): Promise<ModelDirectoryInput[]> {
  if (!directory.files.some(file => /\.gguf$/i.test(file.relativePath) && file.relativePath.includes('/'))) {
    return [directory];
  }
  const { localRepositoryLayoutChoices } = await import('@/features/llama-cpp-browser/runtime/local-repository-layout');
  operation.controller.signal.throwIfAborted();
  const choices = localRepositoryLayoutChoices({ directory });
  if (!choices.length) {
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
  if (choices.length === 1 && choices[0]) {
    return choices[0].directories;
  }
  return new Promise<ModelDirectoryInput[]>((resolve, reject) => {
    const signal = operation.controller.signal;
    const cancel = () => {
      if (localInputSelection.value?.operation === operation) {
        localInputSelection.value = undefined;
      }
      reject(signal.reason);
    };
    signal.addEventListener('abort', cancel, { once: true });
    localInputSelection.value = {
      operation,
      status: 'layout',
      rootName: directory.rootName,
      choices,
      chooseLayout: ({ layout }) => {
        const choice = choices.find(choice => choice.layout === layout);
        if (!choice || !currentInput({ operation })) {
          return;
        }
        signal.removeEventListener('abort', cancel);
        localInputSelection.value = undefined;
        resolve(choice.directories);
      },
    };
  });
}

export function startLocalModelInput({ directories, controller, context, save, repositoryLayout, acceptFiles }: {
  directories: Promise<ModelDirectoryInput[]>,
  controller: AbortController,
  context: ModelLaunchStartContext,
  save?: 'browser' | 'later',
  repositoryLayout?: 'confirmed',
  acceptFiles?: ({ directories, controller, save }: { directories: Promise<ModelDirectoryInput[]>, controller: AbortController, save: 'browser' | 'later' }) => void,
}): Promise<void> {
  const pending = inputPromises.get(controller);
  if (pending !== undefined) {
    return pending;
  }
  activeInput?.controller.abort();
  localInputSelection.value = undefined;
  const operation: LocalInputOperation = {
    controller,
    context,
    isStorageCurrent: storageService.captureModelLaunchStorage(),
    defaults: context.defaults,
    candidates: [],
    attempts: new Map(),
  };
  activeInput = operation;
  // The capture starts immediately; suppress an unhandled rejection while file
  // enumeration is pending, but retain it for the actual launch to report.
  void operation.defaults.catch(() => {});
  const promise = (async () => {
    const captured = await directories;
    const inputs: ModelDirectoryInput[] = [];
    for (const directory of captured) {
      if (!currentInput({ operation })) {
        return;
      }
      // The shared file input resolves only after confirming repository boundaries.
      // Direct welcome drops still need the owner's existing layout dialog.
      switch (repositoryLayout) {
      case 'confirmed': inputs.push(directory);
        break;
      case undefined: inputs.push(...await confirmLocalInputLayout({ directory, operation }));
        break;
      default: {
        const exhaustive: never = repositoryLayout;
        throw new Error(String(exhaustive));
      }
      }
    }
    if (!currentInput({ operation })) {
      return;
    }
    if (acceptFiles !== undefined) {
      // The existing chat takes ownership only after the same repository
      // confirmation as a new chat. Retiring the chooser must not cancel it.
      activeInput = undefined;
      acceptFiles({ directories: Promise.resolve(inputs), controller, save: save ?? 'later' });
      return;
    }
    for (const directory of inputs) {
      const receipt = await llamaCppBrowserModelFiles.importLocalDirectory({ directory, save: save ?? 'later', signal: controller.signal });
      if (!currentInput({ operation })) {
        return;
      }
      operation.candidates.push(...receipt.models.map(model => ({ model, isCurrent: () => receipt.publication.isCurrent({ modelId: model.modelId }) })));
    }
    const candidates = operation.candidates.filter(candidate => candidate.isCurrent());
    if (!candidates.length) {
      throw new Error('No usable local model configuration');
    }
    operation.candidates = candidates;
    if (candidates.length === 1 && candidates[0] !== undefined) {
      try {
        await startInputCandidate({ operation, candidate: candidates[0] });
      } catch (error) {
        if (!currentInput({ operation })) {
          return;
        }
        localInputSelection.value = { operation, status: 'choosing', error: 'start-failed' };
        throw error;
      }
    } else {
      localInputSelection.value = { operation, status: 'choosing', error: undefined };
    }
  })();
  inputPromises.set(controller, promise);
  return promise;
}

export function useBrowserModelLocalInputSelection() {
  const selection = computed(() => {
    const current = localInputSelection.value;
    if (current === undefined || !currentInput({ operation: current.operation })) {
      return undefined;
    }
    switch (current.status) {
    case 'layout': return {
      kind: 'layout' as const,
      rootName: current.rootName,
      choices: current.choices,
      chooseLayout: current.chooseLayout,
      models: [],
      status: 'choosing' as const,
      error: undefined,
    };
    case 'choosing': case 'starting': return {
      kind: 'models' as const,
      models: current.operation.candidates.filter(candidate => candidate.isCurrent()).map(candidate => candidate.model),
      status: current.status,
      error: current.error,
    };
    default: {
      const exhaustive: never = current;
      throw new Error(String(exhaustive));
    }
    }
  });

  async function choose({ modelId }: { modelId: string }): Promise<void> {
    const current = localInputSelection.value;
    if (current === undefined || current.status === 'starting' || current.status === 'layout' || !currentInput({ operation: current.operation })) {
      return;
    }
    const candidate = current.operation.candidates.find(candidate => candidate.model.modelId === modelId && candidate.isCurrent());
    if (candidate === undefined) {
      return;
    }
    localInputSelection.value = { ...current, status: 'starting', error: undefined };
    try {
      await startInputCandidate({ operation: current.operation, candidate });
      if (localInputSelection.value?.operation === current.operation) {
        localInputSelection.value = undefined;
      }
    } catch {
      if (localInputSelection.value?.operation === current.operation && currentInput({ operation: current.operation })) {
        localInputSelection.value = { ...current, status: 'choosing', error: 'start-failed' };
      }
    }
  }

  function cancel(): void {
    activeInput?.controller.abort();
    activeInput = undefined;
    localInputSelection.value = undefined;
  }

  return {
    selection: readonly(selection),
    choose,
    cancel,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

/** Create inside setup so routing and disposal are captured before a click. */
export function useLocalModelStart() {
  const router = useRouter();
  const entry = useAppEntry();
  let disposed = false;
  let routeRevision = 0;
  let activeAttempt: LocalLaunchAttempt | undefined;
  const attempts = new Map<string, LocalLaunchAttempt>();
  watch(() => router.currentRoute.value.fullPath, () => {
    routeRevision++;
  }, { flush: 'sync' });
  onScopeDispose(() => {
    disposed = true;
  });

  function startLocalModel({ model, signal }: { model: LocalModel, signal: AbortSignal }): Promise<void> {
    if (disposed || signal.aborted) {
      return Promise.resolve();
    }
    let attempt = attempts.get(model.modelId);
    if (attempt === undefined || !attempt.isStorageCurrent()
      || (attempt.promise === undefined && attempt.source !== undefined && !attempt.source.isCurrent())) {
      attempt = createAttempt();
      attempts.set(model.modelId, attempt);
    }
    if (attempt.promise !== undefined) {
      return attempt.promise;
    }
    const selectedAttempt = attempt;
    activeAttempt = selectedAttempt;
    const revision = routeRevision;
    const current = () => !disposed && !signal.aborted && activeAttempt === selectedAttempt && selectedAttempt.isStorageCurrent() && routeRevision === revision;
    let noticeRevision = 0;
    let verifiedRevision = -1;
    let selected: LocalModel | undefined;
    let selectedSignature: string | undefined;
    let failure: { error: unknown } | undefined;
    let checking: Promise<void> | undefined;
    const check = async ({ refresh }: { refresh: 'if-needed' | 'now' }): Promise<void> => {
      if (!current()) {
        return;
      }
      switch (refresh) {
      case 'if-needed': break;
      case 'now': noticeRevision++;
        break;
      default: {
        const exhaustive: never = refresh;
        throw new Error(String(exhaustive));
      }
      }
      while (current() && verifiedRevision !== noticeRevision) {
        if (selectedAttempt.source !== undefined && !selectedAttempt.source.isCurrent()) {
          throw new Error('Local model files changed');
        }
        if (failure !== undefined) {
          throw failure.error;
        }
        if (checking === undefined) {
          const requestedRevision = noticeRevision;
          const read = (async () => {
            try {
              const available = await llamaCppBrowserModelFiles.getModelEntry({ modelId: model.modelId, signal });
              if (!current() || requestedRevision !== noticeRevision) {
                return;
              }
              if (available.modelId !== model.modelId) {
                throw new Error('Local model unavailable');
              }
              if (available.size !== model.size || available.importedAt !== model.importedAt) {
                throw new Error('Local model files changed');
              }
              const signature = JSON.stringify(available);
              if (selectedSignature !== undefined && signature !== selectedSignature) {
                throw new Error('Local model files changed');
              }
              selected ??= available;
              selectedSignature ??= signature;
              verifiedRevision = requestedRevision;
            } catch (error) {
              if (current()) {
                failure = { error };
                throw error;
              }
            }
          })();
          checking = read;
          void read.finally(() => {
            if (checking === read) {
              checking = undefined;
            }
          }).catch(() => {});
        }
        await checking;
      }
      if (current() && selectedAttempt.source !== undefined && !selectedAttempt.source.isCurrent()) {
        throw new Error('Local model files changed');
      }
      if (failure !== undefined) {
        throw failure.error;
      }
    };
    const validation: LocalModelValidation = {
      isCurrent: () => failure === undefined && verifiedRevision === noticeRevision,
      check,
    };
    const unsubscribe = llamaCppBrowserModelFiles.subscribeModelList({
      listener: () => {
        noticeRevision++;
        void check({ refresh: 'if-needed' }).catch(() => {});
      },
    });
    const sourcePin = retainLocalRepositorySource({ modelId: model.modelId });
    const promise = (async () => {
      if (selectedAttempt.source !== undefined && !selectedAttempt.source.isCurrent()) {
        throw new Error('Local model files changed');
      }
      const source = selectedAttempt.source ?? (isPendingLocalModelReference({ modelId: model.modelId }) ? await captureTemporaryModelSource({ modelId: model.modelId, signal }) : undefined);
      selectedAttempt.source = source;
      await check({ refresh: 'if-needed' });
      if (!current()) {
        return;
      }
      const available = selected;
      if (available === undefined) {
        throw new Error('Local model unavailable');
      }
      await prepareLocalChat({
        model: available,
        source,
        attempt: selectedAttempt,
        signal,
        isCurrent: current,
        defaults: undefined,
        homeOriginId: entry.captureModelLaunchContext().homeOriginId,
        validation,
        navigate: async ({ chatPath }) => {
          await check({ refresh: 'if-needed' });
          if (!current()) {
            return false;
          }
          const failure = await router.push({ path: chatPath, query: {} });
          if (failure) {
            throw new Error('Could not open the created chat');
          }
          return selectedAttempt.isStorageCurrent() && router.currentRoute.value.path === chatPath;
        },
      });
      if (router.currentRoute.value.path === `/chat/${idToRaw({ id: selectedAttempt.chatId })}`) {
        attempts.delete(model.modelId);
      }
    })().catch(error => {
      if (current()) {
        throw error;
      }
    });
    selectedAttempt.promise = promise;
    void promise.finally(() => {
      unsubscribe();
      sourcePin?.release();
      selectedAttempt.promise = undefined;
    }).catch(() => {});
    return promise;
  }

  return {
    startLocalModel,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export const TEST_ONLY = {
};
