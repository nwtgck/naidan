import { readonly, shallowRef, type DeepReadonly, type Ref } from 'vue';

import { createPromptApiSession, getPromptApiAvailability, getPromptApiLanguageModel } from './api';
import { PromptApiError, normalizePromptApiError } from './errors';
import type { PromptApiMessage, PromptApiSession } from './language-model';

export type PromptApiRuntimeState =
  | { status: 'unchecked' }
  | { status: 'checking' }
  | { status: 'api_unavailable' }
  | { status: 'model_unavailable' }
  | { status: 'downloadable' }
  | { status: 'downloading', progress: number | undefined }
  | { status: 'preparing' }
  | { status: 'ready' }
  | { status: 'error', error: PromptApiError };

export type PromptApiGenerationSessionLease = {
  session: PromptApiSession,
  release(): void,
};

type PromptApiSessionStateSnapshot = {
  activeGenerationSessionCount: number,
  hasActivatedPromptApi: boolean,
  hasWarmKeeper: boolean,
  hasWarmKeeperCreation: boolean,
  hasWarmKeeperRecreationTimer: boolean,
  pendingGenerationSessionCount: number,
};

const WARM_KEEPER_RECREATE_DELAY_MS = 1_500;

const mutableState = shallowRef<PromptApiRuntimeState>({ status: 'unchecked' });
export const promptApiRuntimeState: DeepReadonly<Ref<PromptApiRuntimeState>> = readonly(mutableState);

let preparationPromise: Promise<void> | undefined;
let preparationRevision = 0;
let availabilityRefreshRevision = 0;
let monitoringReferences = 0;
let pollingTimer: ReturnType<typeof setInterval> | undefined;

let runtimeLifecycleRevision = 0;
let warmKeeper: PromptApiSession | undefined;
let warmKeeperCreationPromise: Promise<void> | undefined;
let warmKeeperRecreationTimer: ReturnType<typeof setTimeout> | undefined;
let pendingGenerationSessionCount = 0;
const activeGenerationSessions = new Set<PromptApiSession>();
let hasActivatedPromptApi = false;

function updatePolling(): void {
  const shouldPoll = (
    monitoringReferences > 0
    && mutableState.value.status === 'downloading'
  );

  if (shouldPoll && pollingTimer === undefined) {
    pollingTimer = setInterval(() => {
      void refreshPromptApiAvailability({ showCheckingState: 'no' });
    }, 1000);
    return;
  }

  if (!shouldPoll && pollingTimer !== undefined) {
    clearInterval(pollingTimer);
    pollingTimer = undefined;
  }
}

function setState({ state }: { state: PromptApiRuntimeState }): void {
  mutableState.value = state;
  updatePolling();
}

function invalidateAvailabilityRefreshes(): void {
  availabilityRefreshRevision += 1;
}

function isCurrentAvailabilityRefresh({ revision }: { revision: number }): boolean {
  return (
    revision === availabilityRefreshRevision
    && preparationPromise === undefined
  );
}

function cancelWarmKeeperRecreation(): void {
  if (warmKeeperRecreationTimer === undefined) return;
  clearTimeout(warmKeeperRecreationTimer);
  warmKeeperRecreationTimer = undefined;
}

function destroyWarmKeeper(): void {
  const session = warmKeeper;
  warmKeeper = undefined;
  session?.destroy();
}

function canCreateWarmKeeper(): boolean {
  return (
    hasActivatedPromptApi
    && warmKeeper === undefined
    && warmKeeperCreationPromise === undefined
    && warmKeeperRecreationTimer === undefined
    && preparationPromise === undefined
    && pendingGenerationSessionCount === 0
    && activeGenerationSessions.size === 0
  );
}

function setAvailabilityState({ availability }: {
  availability: Awaited<ReturnType<typeof getPromptApiAvailability>>,
}): void {
  switch (availability) {
  case 'available':
    setState({ state: { status: 'ready' } });
    scheduleWarmKeeperRecreation();
    return;
  case 'downloadable':
    cancelWarmKeeperRecreation();
    destroyWarmKeeper();
    setState({ state: { status: 'downloadable' } });
    return;
  case 'downloading':
  {
    cancelWarmKeeperRecreation();
    destroyWarmKeeper();
    const currentState = mutableState.value;
    const progress = (() => {
      switch (currentState.status) {
      case 'downloading':
        return currentState.progress;
      case 'unchecked':
      case 'checking':
      case 'api_unavailable':
      case 'model_unavailable':
      case 'downloadable':
      case 'preparing':
      case 'ready':
      case 'error':
        return undefined;
      default: {
        const _ex: never = currentState;
        throw new Error(`Unhandled Prompt API runtime state: ${String(_ex)}`);
      }
      }
    })();

    setState({
      state: {
        status: 'downloading',
        progress,
      },
    });
    return;
  }
  case 'unavailable':
    cancelWarmKeeperRecreation();
    destroyWarmKeeper();
    setState({ state: { status: 'model_unavailable' } });
    return;
  default: {
    const _ex: never = availability;
    throw new Error(`Unhandled Prompt API availability: ${_ex}`);
  }
  }
}

function handleBackgroundWarmKeeperError({ error }: { error: unknown }): void {
  const normalized = normalizePromptApiError({ error });
  switch (normalized.code) {
  case 'api_unavailable':
    cancelWarmKeeperRecreation();
    destroyWarmKeeper();
    setState({ state: { status: 'api_unavailable' } });
    return;
  case 'model_unavailable':
    cancelWarmKeeperRecreation();
    destroyWarmKeeper();
    setState({ state: { status: 'model_unavailable' } });
    return;
  case 'preparation_required':
    cancelWarmKeeperRecreation();
    destroyWarmKeeper();
    setState({ state: { status: 'downloadable' } });
    return;
  case 'aborted':
  case 'unsupported_input':
  case 'operation_failed':
    // Recreating the empty keeper is an optimization. A failure must not turn
    // an already completed generation into an application-visible error.
    return;
  default: {
    const _ex: never = normalized.code;
    throw new Error(`Unhandled Prompt API error code: ${_ex}`);
  }
  }
}

async function createWarmKeeper(): Promise<void> {
  if (!canCreateWarmKeeper()) return;

  const lifecycleRevision = runtimeLifecycleRevision;
  let shouldReevaluateAfterFinalization = false;
  const run = async (): Promise<void> => {
    try {
      const availability = await getPromptApiAvailability();
      if (lifecycleRevision !== runtimeLifecycleRevision) return;

      switch (availability) {
      case 'available':
        break;
      case 'downloadable':
      case 'downloading':
      case 'unavailable':
        setAvailabilityState({ availability });
        return;
      default: {
        const _ex: never = availability;
        throw new Error(`Unhandled Prompt API availability: ${_ex}`);
      }
      }

      const session = await createPromptApiSession({
        initialPrompts: [],
        signal: undefined,
        onDownloadProgress: undefined,
      });

      if (
        lifecycleRevision !== runtimeLifecycleRevision
        || !hasActivatedPromptApi
        || preparationPromise !== undefined
        || pendingGenerationSessionCount > 0
        || activeGenerationSessions.size > 0
        || warmKeeper !== undefined
      ) {
        shouldReevaluateAfterFinalization = (
          lifecycleRevision === runtimeLifecycleRevision
          && hasActivatedPromptApi
          && warmKeeper === undefined
        );
        session.destroy();
        return;
      }

      warmKeeper = session;
      setState({ state: { status: 'ready' } });
    } catch (error) {
      if (lifecycleRevision !== runtimeLifecycleRevision) return;
      handleBackgroundWarmKeeperError({ error });
    }
  };

  const running = run();
  const finalized = running.finally(() => {
    if (warmKeeperCreationPromise === finalized) {
      warmKeeperCreationPromise = undefined;
      if (shouldReevaluateAfterFinalization) {
        scheduleWarmKeeperRecreation();
      }
    }
  });
  warmKeeperCreationPromise = finalized;
  await finalized;
}

function scheduleWarmKeeperRecreation(): void {
  if (!canCreateWarmKeeper()) return;

  warmKeeperRecreationTimer = setTimeout(() => {
    warmKeeperRecreationTimer = undefined;
    void createWarmKeeper();
  }, WARM_KEEPER_RECREATE_DELAY_MS);
}

async function requireAvailablePromptApi(): Promise<void> {
  let availability: Awaited<ReturnType<typeof getPromptApiAvailability>>;
  try {
    availability = await getPromptApiAvailability();
  } catch (error) {
    const normalized = normalizePromptApiError({ error });
    switch (normalized.code) {
    case 'api_unavailable':
      cancelWarmKeeperRecreation();
      destroyWarmKeeper();
      setState({ state: { status: 'api_unavailable' } });
      break;
    case 'model_unavailable':
    case 'preparation_required':
    case 'unsupported_input':
    case 'aborted':
    case 'operation_failed':
      break;
    default: {
      const _ex: never = normalized.code;
      throw new Error(`Unhandled Prompt API error code: ${_ex}`);
    }
    }
    throw normalized;
  }

  switch (availability) {
  case 'available':
    setState({ state: { status: 'ready' } });
    return;
  case 'downloadable':
  case 'downloading':
    setAvailabilityState({ availability });
    throw new PromptApiError({
      code: 'preparation_required',
      message: 'Prompt API model preparation is required.',
    });
  case 'unavailable':
    setAvailabilityState({ availability });
    throw new PromptApiError({
      code: 'model_unavailable',
      message: 'Prompt API model is unavailable.',
    });
  default: {
    const _ex: never = availability;
    throw new Error(`Unhandled Prompt API availability: ${_ex}`);
  }
  }
}

export async function refreshPromptApiAvailability({
  showCheckingState,
}: {
  showCheckingState: 'yes' | 'no',
}): Promise<void> {
  // Preparation owns runtime state while create() is downloading or loading a
  // model. A focus event or polling tick must not replace its progress state.
  if (preparationPromise !== undefined) return;

  const refreshRevision = availabilityRefreshRevision + 1;
  availabilityRefreshRevision = refreshRevision;

  if (getPromptApiLanguageModel() === undefined) {
    if (isCurrentAvailabilityRefresh({ revision: refreshRevision })) {
      cancelWarmKeeperRecreation();
      destroyWarmKeeper();
      setState({ state: { status: 'api_unavailable' } });
    }
    return;
  }

  switch (showCheckingState) {
  case 'yes':
    setState({ state: { status: 'checking' } });
    break;
  case 'no':
    break;
  default: {
    const _ex: never = showCheckingState;
    throw new Error(`Unhandled checking-state mode: ${_ex}`);
  }
  }

  try {
    const availability = await getPromptApiAvailability();
    if (!isCurrentAvailabilityRefresh({ revision: refreshRevision })) return;
    setAvailabilityState({ availability });
  } catch (error) {
    if (!isCurrentAvailabilityRefresh({ revision: refreshRevision })) return;

    const normalized = normalizePromptApiError({ error });
    switch (normalized.code) {
    case 'api_unavailable':
      cancelWarmKeeperRecreation();
      destroyWarmKeeper();
      setState({ state: { status: 'api_unavailable' } });
      return;
    case 'model_unavailable':
    case 'preparation_required':
    case 'unsupported_input':
    case 'aborted':
    case 'operation_failed':
      setState({ state: { status: 'error', error: normalized } });
      return;
    default: {
      const _ex: never = normalized.code;
      throw new Error(`Unhandled Prompt API error code: ${_ex}`);
    }
    }
  }
}

export async function preparePromptApi({ signal }: {
  signal: AbortSignal | undefined,
}): Promise<void> {
  signal?.throwIfAborted();

  if (warmKeeper !== undefined) {
    setState({ state: { status: 'ready' } });
    return;
  }
  if (preparationPromise !== undefined) return preparationPromise;

  cancelWarmKeeperRecreation();
  const currentPreparationRevision = preparationRevision + 1;
  preparationRevision = currentPreparationRevision;
  const lifecycleRevision = runtimeLifecycleRevision;
  invalidateAvailabilityRefreshes();
  let refreshAfterAbort = false;

  const isCurrentPreparation = (): boolean => (
    currentPreparationRevision === preparationRevision
    && lifecycleRevision === runtimeLifecycleRevision
  );

  const run = async (): Promise<void> => {
    if (getPromptApiLanguageModel() === undefined) {
      if (isCurrentPreparation()) {
        setState({ state: { status: 'api_unavailable' } });
      }
      throw new PromptApiError({
        code: 'api_unavailable',
        message: 'LanguageModel API is unavailable.',
      });
    }

    if (isCurrentPreparation()) {
      setState({ state: { status: 'preparing' } });
    }

    let session: PromptApiSession | undefined;
    try {
      session = await createPromptApiSession({
        initialPrompts: [],
        signal,
        onDownloadProgress: ({ progress }) => {
          if (!isCurrentPreparation()) return;
          setState({
            state: progress >= 1
              ? { status: 'preparing' }
              : { status: 'downloading', progress },
          });
        },
      });

      if (!isCurrentPreparation()) {
        session.destroy();
        session = undefined;
        return;
      }

      hasActivatedPromptApi = true;
      if (
        pendingGenerationSessionCount === 0
        && activeGenerationSessions.size === 0
        && warmKeeper === undefined
      ) {
        warmKeeper = session;
        session = undefined;
      }

      session?.destroy();
      session = undefined;
      setState({ state: { status: 'ready' } });
    } catch (error) {
      session?.destroy();
      const normalized = normalizePromptApiError({ error });
      if (isCurrentPreparation()) {
        switch (normalized.code) {
        case 'aborted':
          refreshAfterAbort = true;
          break;
        case 'api_unavailable':
        case 'model_unavailable':
        case 'preparation_required':
        case 'unsupported_input':
        case 'operation_failed':
          setState({ state: { status: 'error', error: normalized } });
          break;
        default: {
          const _ex: never = normalized.code;
          throw new Error(`Unhandled Prompt API error code: ${_ex}`);
        }
        }
      }
      throw normalized;
    }
  };

  const running = run();
  const finalized = running.finally(async () => {
    if (preparationPromise === finalized) {
      preparationPromise = undefined;
    }
    if (refreshAfterAbort && isCurrentPreparation()) {
      await refreshPromptApiAvailability({ showCheckingState: 'no' });
    }
  });
  preparationPromise = finalized;
  return finalized;
}

export async function acquirePromptApiGenerationSession({
  initialPrompts,
  signal,
}: {
  initialPrompts: PromptApiMessage[],
  signal: AbortSignal | undefined,
}): Promise<PromptApiGenerationSessionLease> {
  signal?.throwIfAborted();
  cancelWarmKeeperRecreation();

  const lifecycleRevision = runtimeLifecycleRevision;
  pendingGenerationSessionCount += 1;
  let pendingRegistrationActive = true;

  const releasePendingRegistration = (): void => {
    if (!pendingRegistrationActive) return;
    pendingRegistrationActive = false;
    if (lifecycleRevision === runtimeLifecycleRevision) {
      pendingGenerationSessionCount = Math.max(0, pendingGenerationSessionCount - 1);
    }
  };

  try {
    await requireAvailablePromptApi();
    const session = await createPromptApiSession({
      initialPrompts,
      signal,
      onDownloadProgress: undefined,
    });

    releasePendingRegistration();
    if (lifecycleRevision !== runtimeLifecycleRevision) {
      session.destroy();
      throw new PromptApiError({
        code: 'aborted',
        message: 'Prompt API runtime was reset while creating a session.',
      });
    }

    activeGenerationSessions.add(session);
    hasActivatedPromptApi = true;

    // Keep the model continuously attached to a live session: only remove the
    // empty keeper after the generation session has been created successfully.
    destroyWarmKeeper();
    setState({ state: { status: 'ready' } });

    let released = false;
    return {
      session,
      release(): void {
        if (released) return;
        released = true;
        if (!activeGenerationSessions.delete(session)) return;

        try {
          session.destroy();
        } finally {
          scheduleWarmKeeperRecreation();
        }
      },
    };
  } catch (error) {
    releasePendingRegistration();
    scheduleWarmKeeperRecreation();
    throw normalizePromptApiError({ error });
  }
}

function handleWindowFocus(): void {
  void refreshPromptApiAvailability({ showCheckingState: 'no' });
}

function handleVisibilityChange(): void {
  switch (document.visibilityState) {
  case 'visible':
    void refreshPromptApiAvailability({ showCheckingState: 'no' });
    return;
  case 'hidden':
    return;
  default: {
    const _ex: never = document.visibilityState;
    throw new Error(`Unhandled document visibility state: ${_ex}`);
  }
  }
}

export function acquirePromptApiRuntimeMonitoring(): () => void {
  monitoringReferences += 1;

  if (monitoringReferences === 1) {
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleWindowFocus);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    void refreshPromptApiAvailability({ showCheckingState: 'yes' });
  }

  updatePolling();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    monitoringReferences = Math.max(0, monitoringReferences - 1);

    if (monitoringReferences === 0) {
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleWindowFocus);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    }

    updatePolling();
  };
}

function disposePromptApiSessionResources(): void {
  runtimeLifecycleRevision += 1;
  preparationRevision += 1;
  invalidateAvailabilityRefreshes();
  preparationPromise = undefined;
  warmKeeperCreationPromise = undefined;
  hasActivatedPromptApi = false;
  pendingGenerationSessionCount = 0;

  cancelWarmKeeperRecreation();
  destroyWarmKeeper();

  for (const session of activeGenerationSessions) {
    session.destroy();
  }
  activeGenerationSessions.clear();
}

export const TEST_ONLY = {
  WARM_KEEPER_RECREATE_DELAY_MS,
  getSessionState(): PromptApiSessionStateSnapshot {
    return {
      activeGenerationSessionCount: activeGenerationSessions.size,
      hasActivatedPromptApi,
      hasWarmKeeper: warmKeeper !== undefined,
      hasWarmKeeperCreation: warmKeeperCreationPromise !== undefined,
      hasWarmKeeperRecreationTimer: warmKeeperRecreationTimer !== undefined,
      pendingGenerationSessionCount,
    };
  },
  reset(): void {
    disposePromptApiSessionResources();
    monitoringReferences = 0;
    if (pollingTimer !== undefined) clearInterval(pollingTimer);
    pollingTimer = undefined;
    mutableState.value = { status: 'unchecked' };
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', handleWindowFocus);
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    }
  },
};
