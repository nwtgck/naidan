import { useRestoredModelLaunch } from './useRestoredModelLaunch';
import { computed, onScopeDispose, ref, shallowRef, watch, type ComputedRef } from 'vue';
import { useSettings } from '@/composables/useSettings';
import type { Chat, Endpoint } from '@/01-models/types';
import { generateId } from '@/01-models/id';
import { idToRaw, type ChatGroupId } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import { loadData, registerLiveInstance } from '@/composables/chat/global/chat-core-singletons';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { getDownloadQueue, jobIsBusy } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { selectionKey } from '@/features/llama-cpp-browser/hugging-face/download-plan';
import { getMetadataSession } from '@/features/llama-cpp-browser/hugging-face/metadata-session';
import { variantLabel } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { modelLaunchChatGroupName, modelLaunchChoices, readLaunchCatalog, rememberLaunchCatalog, sameLaunchTarget, targetForChoice } from '@/features/llama-cpp-browser/model-launch/target';
import { isModelLaunchTargetReady } from '@/features/llama-cpp-browser/model-launch/readiness';
import { registerModelLaunchPreparation } from '@/features/llama-cpp-browser/model-launch/preparation';
import type { ModelLaunchDefaultSnapshot } from '@/features/llama-cpp-browser/model-launch/defaults';
import type { Progress } from '@/features/llama-cpp-browser/types';
import { modelLaunchPresentation } from '@/features/llama-cpp-browser/model-launch/presentation';
import { isMissing, readJournal, repositoryFolder } from '@/features/llama-cpp-browser/hugging-face/storage';
import { destinationKey } from '@/features/llama-cpp-browser/runtime/model-destination-types';
import { formatHostModelId } from '@/features/llama-cpp-browser/runtime/host-model-aliases';
import { consumeModelLaunchSession, readModelLaunchSession } from '@/features/llama-cpp-browser/model-launch/session';
import { useAppEntry } from '@/composables/useAppEntry';
import { observeLegacyModelDownload } from '@/features/llama-cpp-browser/model-launch/restore';
import { hostModelPermissionGranted } from '@/logic/host-model-directories';

export function useModelLaunchChat({ chat, resolved }: {
  chat: ComputedRef<Chat | null>, resolved: ComputedRef<{ endpoint: Endpoint, modelId: string | undefined } | undefined>,
}) {
  const settingsApi = useSettings();
  const appEntry = useAppEntry();
  const queue = getDownloadQueue();
  const { launch, observedDownload, isCurrentRoute, restoration, retryRestoration, synchronize } = useRestoredModelLaunch({ chat, resolved });
  const presentation = computed(() => modelLaunchPresentation({ input: launch.value?.input ?? observedDownload.value?.target.selection.repository }));
  const downloadContext = computed(() => launch.value ?? observedDownload.value);
  const effectiveTarget = computed(() => {
    const context = downloadContext.value;
    return context !== undefined && (launch.value?.phase === 'active' || observedDownload.value !== undefined)
      && resolved.value?.endpoint.type === 'llama_cpp_browser' && resolved.value.modelId === context.effectiveModelId ? context.target : undefined;
  });
  const visible = computed(() => {
    if (observedDownload.value !== undefined) {
      return isCurrentRoute.value && effectiveTarget.value !== undefined;
    }
    const phase = launch.value?.phase;
    switch (phase) {
    case 'reserved': return true;
    case 'active': return effectiveTarget.value !== undefined;
    case 'detached': case undefined: return false;
    default: {
      const exhaustive: never = phase;
      throw new Error(String(exhaustive));
    }
    }
  });
  const catalog = shallowRef<ReturnType<typeof readLaunchCatalog>>();
  const selectedPath = ref('');
  const selectedTarget = computed(() => {
    const saved = downloadContext.value?.target;
    if (saved === undefined || selectedPath.value === saved.mainFilePath) {
      return saved;
    }
    if (catalog.value === undefined) {
      return undefined;
    }
    try {
      return targetForChoice({ catalog: catalog.value, path: selectedPath.value });
    } catch {
      return undefined;
    }
  });
  const choices = computed(() => catalog.value === undefined ? [] : modelLaunchChoices({ catalog: catalog.value }));
  const selectionChanged = computed(() => selectedTarget.value !== undefined && launch.value !== undefined
    && !sameLaunchTarget({ left: selectedTarget.value, right: launch.value.target }));
  // Keep the last confirmed display for this target while rechecking its files.
  // Model-list/focus notifications must not make a ready model flash a Start
  // button. Sending is independently gated by verification below.
  const readiness = ref<'checking' | 'missing' | 'ready' | 'failed'>('checking');
  const verification = ref<'idle' | 'checking'>('idle');
  let readinessContext: string | undefined;
  let readinessStorageCurrent: (() => boolean) | undefined;
  const warmup = ref<'idle' | 'loading' | 'ready' | 'deferred' | 'failed'>('idle');
  const warmupProgress = shallowRef<Progress>();
  let warmupController: AbortController | undefined;
  let warmupKey: string | undefined;
  const operation = ref<'idle' | 'adopting' | 'checking'>('idle');
  const error = ref(false);
  const defaultWarning = ref(false);
  const hasPausedDownload = ref(false);
  const runtimeState = shallowRef(llamaCppBrowserService.getState());
  const runtimeUnavailable = computed(() => runtimeState.value.status === 'unavailable');
  const job = computed(() => {
    const target = selectedTarget.value;
    if (target === undefined) {
      return undefined;
    }
    const key = selectionKey({ selection: target.selection });
    const matching = queue.jobs.value.filter(candidate => destinationKey({ destination: candidate.destination }) === destinationKey({ destination: downloadContext.value?.destination })
      && (candidate.key === key || candidate.selection !== undefined && selectionKey({ selection: candidate.selection }) === key));
    return matching.find(candidate => jobIsBusy({ job: candidate })) ?? matching.at(-1);
  });
  const verifiedCompletedJob = ref<number>();
  const downloadVerificationPending = computed(() => job.value?.status === 'complete' && job.value.id !== verifiedCompletedJob.value);
  const busy = computed(() => operation.value !== 'idle' || jobIsBusy({ job: job.value }));
  const isActive = computed(() => effectiveTarget.value !== undefined);
  const needsRecovery = computed(() => launch.value?.phase === 'reserved');
  const maySend = computed(() => !visible.value || restoration.value === 'idle' && !needsRecovery.value && (!isActive.value || (observedDownload.value === undefined && readiness.value === 'ready' && (warmup.value === 'ready' || (chat.value?.root.items.length ?? 0) > 0) && verification.value === 'idle' && !selectionChanged.value && !busy.value && !runtimeUnavailable.value)));
  // The real Chat owns drafts as soon as Start saves it, including preparation.
  const composerVisibility = computed<'visible' | 'hidden'>(() => 'visible');
  const label = computed(() => {
    const target = selectedTarget.value;
    return target === undefined ? '' : variantLabel({ repository: target.selection.repository, path: target.mainFilePath });
  });
  let disposed = false;
  let readGeneration = 0;
  let defaults: Promise<ModelLaunchDefaultSnapshot | undefined> = Promise.resolve(undefined);
  let defaultAttempted = false;
  let storageType = settingsApi.settings.value.storageType;
  const controllers = new Set<AbortController>();
  watch(() => chat.value?.id, (chatId, _previous, onCleanup) => {
    if (chatId === undefined) {
      return;
    }
    onCleanup(registerModelLaunchPreparation({
      chatId,
      isReady: ({ target, destination, effectiveModelId }) => {
        const saved = launch.value;
        return !disposed && saved?.phase === 'active' && saved.effectiveModelId === effectiveModelId
          && sameLaunchTarget({ left: saved.target, right: target })
          && destinationKey({ destination: saved.destination }) === destinationKey({ destination })
          && readinessStorageCurrent?.() === true && readiness.value === 'ready' && verification.value === 'idle'
          && warmup.value === 'ready' && restoration.value === 'idle' && !busy.value && !selectionChanged.value && !runtimeUnavailable.value;
      },
    }));
  }, { immediate: true, flush: 'sync' });

  function prepareWhenIdle(): void {
    const target = effectiveTarget.value;
    const current = chat.value;
    if (disposed || launch.value === undefined || !isCurrentRoute.value || current === null || target === undefined || current.root.items.length > 0
      || readiness.value !== 'ready' || verification.value === 'checking' || busy.value || selectionChanged.value || runtimeUnavailable.value
      || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) {
      return;
    }
    const key = `${idToRaw({ id: current.id })}:${target.modelId}`;
    if (warmupKey === key) {
      return;
    }
    warmupController?.abort();
    const controller = new AbortController();
    warmupController = controller;
    warmupKey = key;
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    warmup.value = 'loading';
    warmupProgress.value = undefined;
    void llamaCppBrowserService.prepareModel({
      modelId: launch.value!.effectiveModelId,
      signal: controller.signal,
      onProgress: ({ progress }) => {
      // Operation-local, not the engine's global progress: another chat may own
      // the lane, or this card may already have changed target/storage.
        if (!disposed && !controller.signal.aborted && isStorageCurrent() && warmupKey === key && warmup.value === 'loading') {
          warmupProgress.value = progress;
        }
      },
    }).then(result => {
      if (disposed || controller.signal.aborted || !isStorageCurrent() || warmupKey !== key) {
        return;
      }
      switch (result) {
      case 'ready': warmup.value = 'ready';
        break;
      case 'skipped-busy': warmup.value = 'deferred';
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(String(exhaustive));
      }
      }
    }).catch(() => {
      if (!disposed && !controller.signal.aborted && isStorageCurrent() && warmupKey === key) {
        warmup.value = 'failed';
      }
    });
  }
  watch([() => chat.value?.id, () => effectiveTarget.value?.modelId, () => settingsApi.settings.value.storageType, isCurrentRoute, selectionChanged, readiness], () => {
    warmupController?.abort();
    warmupController = undefined;
    warmupKey = undefined;
    warmup.value = 'idle';
    warmupProgress.value = undefined;
  });
  watch([readiness, verification, busy, selectionChanged, effectiveTarget, isCurrentRoute], prepareWhenIdle);

  async function refresh(): Promise<void> {
    const target = selectedTarget.value;
    const generation = ++readGeneration;
    const checkedJob = job.value;
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    const context = JSON.stringify({ chatId: chat.value?.id, target });
    if (target === undefined) {
      readiness.value = 'failed';
      verification.value = 'idle';
      return;
    }
    if (context !== readinessContext || readinessStorageCurrent?.() !== true || readiness.value === 'failed') {
      readiness.value = 'checking';
      hasPausedDownload.value = false;
    }
    readinessContext = context;
    readinessStorageCurrent = isStorageCurrent;
    verification.value = 'checking';
    const isCurrent = () => !disposed && generation === readGeneration && isStorageCurrent();
    let ready: boolean;
    try {
      ready = await isModelLaunchTargetReady({ target, destination: downloadContext.value?.destination, effectiveModelId: downloadContext.value?.effectiveModelId });
      if (!isCurrent()) {
        return;
      }
      hasPausedDownload.value = false;
      if (!ready) {
        try {
          const folder = await repositoryFolder({ repository: target.selection.repository, create: false, destination: downloadContext.value?.destination });
          const journal = await readJournal({ folder });
          if (isCurrent()) {
            hasPausedDownload.value = selectionKey({ selection: journal.selection }) === selectionKey({ selection: target.selection });
          }
        } catch (cause) {
          if (!isMissing({ error: cause })) {
            throw cause;
          }
        }
      }
      if (!isCurrent()) {
        return;
      }
      readiness.value = ready ? 'ready' : 'missing';
      const checkedStatus = checkedJob?.status;
      switch (checkedStatus) {
      case 'complete':
        verifiedCompletedJob.value = checkedJob?.id;
        break;
      case 'queued': case 'resolving': case 'downloading': case 'pausing': case 'paused': case 'failed': case 'cancelled': case undefined:
        break;
      default: {
        const exhaustive: never = checkedStatus;
        throw new Error(String(exhaustive));
      }
      }
      if (ready && launch.value === undefined) {
        retryRestoration();
      }
    } catch {
      if (isCurrent()) {
        readiness.value = 'failed';
      }
      return;
    } finally {
      if (!disposed && generation === readGeneration) {
        if (!isStorageCurrent()) {
          // A provider can be replaced without changing its storage-type label.
          // Do not keep the previous provider's ready presentation authoritative.
          readinessContext = undefined;
          readinessStorageCurrent = undefined;
          readiness.value = 'checking';
          hasPausedDownload.value = false;
        }
        verification.value = 'idle';
      }
    }

    // Global initialization is optional; do not hold the verified composer
    // hostage while it completes. Check the current route again after awaiting.
    if (ready && launch.value !== undefined && isCurrentRoute.value && isActive.value && !selectionChanged.value && !defaultAttempted
      && storageType === settingsApi.settings.value.storageType) {
      try {
        const expected = await defaults;
        if (!isCurrent() || !isCurrentRoute.value) {
          return;
        }
        if (defaultAttempted || !isActive.value || selectionChanged.value || storageType !== settingsApi.settings.value.storageType) {
          return;
        }
        defaultAttempted = true;
        const session = chat.value === null ? undefined : readModelLaunchSession({ chatId: chat.value.id });
        if (session !== undefined) {
          session.defaultAttempted = true;
        }
        if (expected === undefined) {
          defaultWarning.value = true;
          return;
        }
        await settingsApi.initializeModelLaunchDefaults({ modelId: launch.value!.effectiveModelId, expected });
      } catch {
        if (isCurrent()) {
          defaultWarning.value = true;
        }
      }
    }
  }
  watch([() => chat.value?.id, () => launch.value !== undefined], () => {
    for (const controller of controllers) {
      controller.abort();
    }
    error.value = false;
    operation.value = 'idle';
    const candidate = chat.value === null ? undefined : readModelLaunchSession({ chatId: chat.value.id });
    const session = candidate !== undefined && launch.value !== undefined && sameLaunchTarget({ left: candidate.target, right: launch.value.target }) ? candidate : undefined;
    defaults = session?.defaults ?? Promise.resolve(undefined);
    defaultAttempted = session?.defaultAttempted ?? true;
    defaultWarning.value = false;
    storageType = settingsApi.settings.value.storageType;
  }, { immediate: true });
  watch(() => JSON.stringify(downloadContext.value?.target), () => {
    const target = downloadContext.value?.target;
    selectedPath.value = target?.mainFilePath ?? '';
    catalog.value = target === undefined || launch.value === undefined ? undefined : readLaunchCatalog({ repository: target.selection.repository });
  }, { immediate: true });
  watch([() => chat.value?.id, selectedTarget, queue.changed, () => settingsApi.settings.value.storageType], () => {
    if (downloadContext.value !== undefined) {
      void refresh();
    } else {
      readGeneration++;
      readinessContext = undefined;
      readinessStorageCurrent = undefined;
      readiness.value = 'checking';
      verification.value = 'idle';
    }
  }, { immediate: true, flush: 'sync' });

  async function refreshChoices(): Promise<void> {
    const saved = launch.value;
    if (saved === undefined || busy.value || !isActive.value) {
      return;
    }
    const chatId = chat.value?.id;
    const controller = new AbortController();
    controllers.add(controller);
    operation.value = 'checking';
    error.value = false;
    try {
      const result = await getMetadataSession().inspect({ input: saved.target.selection.repository, signal: controller.signal, freshness: 'refresh' });
      if (disposed || chat.value?.id !== chatId) {
        return;
      }
      rememberLaunchCatalog({ catalog: result });
      catalog.value = result;
      // Refreshing choices is not permission to replace the pinned saved plan.
    } catch {
      if (!controller.signal.aborted && chat.value?.id === chatId) {
        error.value = true;
      }
    } finally {
      controllers.delete(controller);
      if (!disposed && chat.value?.id === chatId) {
        operation.value = 'idle';
      }
    }
  }
  async function recover(): Promise<void> {
    const current = chat.value;
    const saved = launch.value;
    if (current === null || saved?.phase !== 'reserved' || busy.value) {
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    operation.value = 'adopting';
    error.value = false;
    try {
      const updated = await storageService.prepareModelLaunchChat({
        signal: controller.signal,
        request: {
          chatId: current.id,
          newChatGroupId: saved.chatGroupId,
          chatGroupName: modelLaunchChatGroupName({ target: saved.target }),
          input: saved.input,
          requestedVariant: saved.requestedVariant,
          target: saved.target,
          titleGeneration: settingsApi.settings.value.titleGeneration,
          destination: saved.destination,
          effectiveModelId: saved.effectiveModelId,
          mode: 'resume',
          expectedTarget: undefined,
        },
      });
      if (disposed || chat.value?.id !== current.id || controller.signal.aborted) {
        return;
      }
      registerLiveInstance({ chat: updated });
      synchronize();
      await loadData();
      await refresh();
    } catch {
      if (!controller.signal.aborted) {
        error.value = true;
      }
    } finally {
      controllers.delete(controller);
      if (!disposed && chat.value?.id === current.id) {
        operation.value = 'idle';
      }
    }
  }
  async function resumeObservedDownload(): Promise<void> {
    const current = chat.value;
    const observed = observedDownload.value;
    if (current === null || observed === undefined || busy.value || !isCurrentRoute.value || !isActive.value || runtimeUnavailable.value) {
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    const isCurrent = () => !disposed && !controller.signal.aborted && isStorageCurrent() && isCurrentRoute.value
      && chat.value?.id === current.id && observedDownload.value === observed && launch.value === undefined
      && resolved.value?.endpoint.type === 'llama_cpp_browser' && resolved.value.modelId === observed.effectiveModelId;
    operation.value = 'adopting';
    error.value = false;
    try {
      // Ask only in the explicit Resume gesture, using the root already shown.
      // A reload never recovers the physical root authorized by the old Start.
      if (observed.expectedRoot !== undefined && !hostModelPermissionGranted({ permission: await observed.expectedRoot.requestPermission({ mode: 'readwrite' }) })) {
        throw new Error('Model directory needs read and write permission');
      }
      const binding = await storageService.captureModelBinding({ chatId: current.id, sourceModelId: observed.effectiveModelId, isSourceCurrent: isCurrent });
      if (!isCurrent()) {
        return;
      }
      if (binding === undefined) {
        throw new Error('The current model binding changed');
      }
      // Recheck again when this accepted operation reaches the queue. Navigation
      // may then change; provider, binding, pinned files and root must not.
      const prepareResume = async ({ signal }: { signal: AbortSignal }) => {
        const fresh = await observeLegacyModelDownload({ modelId: observed.effectiveModelId, signal });
        const confirmed = await storageService.captureModelBinding({ chatId: current.id, sourceModelId: observed.effectiveModelId, isSourceCurrent: isStorageCurrent });
        signal.throwIfAborted();
        if (!isStorageCurrent() || fresh === undefined || confirmed === undefined || JSON.stringify(binding) !== JSON.stringify(confirmed)
          || !sameLaunchTarget({ left: fresh.target, right: observed.target })
          || destinationKey({ destination: fresh.destination }) !== destinationKey({ destination: observed.destination })
          || (observed.expectedRoot !== undefined && (fresh.expectedRoot === undefined || !await observed.expectedRoot.isSameEntry(fresh.expectedRoot)))) {
          throw new Error('The interrupted model download changed');
        }
        signal.throwIfAborted();
        return fresh.target.selection;
      };
      await prepareResume({ signal: controller.signal });
      if (!isCurrent()) {
        return;
      }
      const queued = queue.enqueue({
        key: selectionKey({ selection: observed.target.selection }),
        repository: observed.target.selection.repository,
        source: 'repository',
        destination: observed.destination,
        expectedRoot: observed.expectedRoot,
        prepare: prepareResume,
      });
      // This grants transfer permission only. It never writes Chat/group/global
      // settings or reconstructs the original launch/default initialization.
      void queued.done.then(() => {
        if (!disposed && isStorageCurrent() && chat.value?.id === current.id) {
          retryRestoration();
        }
      });
    } catch {
      if (!disposed && !controller.signal.aborted && isStorageCurrent() && chat.value?.id === current.id) {
        error.value = true;
        // A changed journal is a new observation, not permission to substitute
        // its files into this click. A subsequent explicit retry may accept it.
        retryRestoration();
      }
    } finally {
      controllers.delete(controller);
      if (!disposed && chat.value?.id === current.id) {
        operation.value = 'idle';
      }
    }
  }
  async function adoptAndDownload(): Promise<void> {
    if (launch.value === undefined) {
      await resumeObservedDownload();
      return;
    }
    const current = chat.value;
    const saved = launch.value;
    const target = selectedTarget.value;
    if (current === null || saved === undefined || target === undefined || busy.value || verification.value === 'checking' || !isActive.value || runtimeUnavailable.value) {
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const isStorageCurrent = storageService.captureModelLaunchStorage();
    operation.value = 'adopting';
    error.value = false;
    try {
      if (selectionChanged.value) {
        const destination = saved.destination;
        let effectiveModelId: string;
        switch (destination.kind) {
        case 'opfs': effectiveModelId = target.modelId;
          break;
        case 'host': effectiveModelId = formatHostModelId({
          directoryId: destination.directoryId,
          repository: target.selection.repository,
          primaryRelativePath: target.mainFilePath,
          directories: await storageService.loadHostModelDirectories(),
        });
          break;
        default: {
          const exhaustive: never = destination;
          throw new Error(String(exhaustive));
        }
        }
        const updated = await storageService.prepareModelLaunchChat({
          signal: controller.signal,
          request: {
            chatId: current.id,
            newChatGroupId: generateId<ChatGroupId>(),
            chatGroupName: modelLaunchChatGroupName({ target }),
            input: saved.input,
            requestedVariant: saved.requestedVariant,
            target,
            titleGeneration: settingsApi.settings.value.titleGeneration,
            destination: saved.destination,
            effectiveModelId,
            mode: 'retarget',
            expectedTarget: saved.target,
          },
        });
        if (disposed || chat.value?.id !== current.id) {
          return;
        }
        registerLiveInstance({ chat: updated });
        synchronize();
        await loadData();
      }
      if (disposed || chat.value?.id !== current.id || !isStorageCurrent() || settingsApi.settings.value.storageType !== storageType) {
        return;
      }
      const ready = await isModelLaunchTargetReady({ target, destination: saved.destination, effectiveModelId: launch.value?.effectiveModelId });
      // Local file inspection is asynchronous too. Recheck intent and storage
      // after it settles, before starting any model transfer.
      if (disposed || controller.signal.aborted || chat.value?.id !== current.id
        || !isStorageCurrent() || settingsApi.settings.value.storageType !== storageType
        || !isActive.value || selectedTarget.value === undefined
        || !sameLaunchTarget({ left: selectedTarget.value, right: target })) {
        return;
      }
      if (!ready) {
        const queued = queue.enqueue({
          key: selectionKey({ selection: target.selection }),
          repository: target.selection.repository,
          source: 'repository',
          destination: saved.destination,
          expectedRoot: readModelLaunchSession({ chatId: current.id })?.expectedRoot,
          prepare: async () => target.selection,
        });
        // The page-owned queue survives card unmounts. Never auto-send on finish.
        void queued.done.then(() => {
          if (!disposed) {
            void refresh();
          }
        });
      }
      await refresh();
    } catch {
      if (!controller.signal.aborted) {
        error.value = true;
        // A failed adoption may already have written its reservation. Reflect
        // that state so sending stays blocked and the same plan can be repaired.
        try {
          const stored = await storageService.loadChat({ id: current.id });
          if (!disposed && isStorageCurrent() && chat.value?.id === current.id && stored !== null) {
            registerLiveInstance({ chat: stored });
          }
        } catch { /* Keep the explicit error and leave recovery to a reload. */ }
      }
    } finally {
      controllers.delete(controller);
      if (!disposed && chat.value?.id === current.id) {
        operation.value = 'idle';
      }
    }
  }
  function selectPath({ path }: { path: string }): void {
    if (launch.value !== undefined && !busy.value) {
      selectedPath.value = path;
      error.value = false;
    }
  }
  function retryWarmup(): void {
    warmupKey = undefined;
    prepareWhenIdle();
  }
  const homeOriginId = computed(() => chat.value === null ? undefined : readModelLaunchSession({ chatId: chat.value.id })?.homeOriginId);
  async function returnToHome(): Promise<void> {
    const origin = homeOriginId.value;
    if (origin !== undefined) {
      const download = job.value;
      if (download !== undefined) {
        // Explicit Back pauses this transfer; unmounting alone keeps it running.
        queue.cancel({ id: download.id });
      }
      await appEntry.returnToHome({ homeOriginId: origin });
    }
  }
  watch(() => chat.value?.root.items.length ?? 0, count => {
    if (count > 0 && chat.value !== null) {
      consumeModelLaunchSession({ chatId: chat.value.id });
    }
  }, { immediate: true, flush: 'sync' });
  const unsubscribeState = llamaCppBrowserService.subscribe({
    listener: ({ state }) => {
      runtimeState.value = state;
      if (state.status === 'idle' && warmup.value === 'deferred') {
        warmupKey = undefined;
        prepareWhenIdle();
      }
    },
  });
  const unsubscribeModels = llamaCppBrowserService.subscribeModelList({
    listener: () => {
      if (downloadContext.value !== undefined) {
        void refresh();
      }
    },
  });
  function onFocus(): void {
    if (downloadContext.value !== undefined) {
      void refresh();
      prepareWhenIdle();
    }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onFocus);
  }
  onScopeDispose(() => {
    disposed = true;
    readGeneration++;
    warmupController?.abort();
    for (const controller of controllers) {
      controller.abort();
    }
    unsubscribeState();
    unsubscribeModels();
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onFocus);
    }
  });
  return {
    launch,
    observedDownload,
    visible,
    presentation,
    warmup,
    warmupProgress,
    restoration,
    retryRestoration,
    selectedTarget,
    selectedPath,
    choices,
    selectionChanged,
    readiness,
    verification,
    operation,
    composerVisibility,
    busy,
    error,
    defaultWarning,
    hasPausedDownload,
    runtimeUnavailable,
    job,
    downloadVerificationPending,
    isActive,
    needsRecovery,
    maySend,
    label,
    refresh,
    refreshChoices,
    adoptAndDownload,
    recover,
    selectPath,
    retryWarmup,
    homeOriginId,
    returnToHome,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

export type ModelLaunchChatUi = ReturnType<typeof useModelLaunchChat>;
export const TEST_ONLY = {
};
