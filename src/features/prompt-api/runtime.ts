import { readonly, shallowRef, type DeepReadonly, type Ref } from 'vue';

import { createPromptApiSession, getPromptApiAvailability, getPromptApiLanguageModel } from './api';
import { normalizePromptApiError, type PromptApiError } from './errors';

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

const mutableState = shallowRef<PromptApiRuntimeState>({ status: 'unchecked' });
export const promptApiRuntimeState: DeepReadonly<Ref<PromptApiRuntimeState>> = readonly(mutableState);

let preparationPromise: Promise<void> | undefined;
let monitoringReferences = 0;
let pollingTimer: ReturnType<typeof setInterval> | undefined;

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

export async function refreshPromptApiAvailability({
  showCheckingState,
}: {
  showCheckingState: 'yes' | 'no',
}): Promise<void> {
  if (getPromptApiLanguageModel() === undefined) {
    setState({ state: { status: 'api_unavailable' } });
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
    switch (availability) {
    case 'available':
      setState({ state: { status: 'ready' } });
      return;
    case 'downloadable':
      setState({ state: { status: 'downloadable' } });
      return;
    case 'downloading':
    {
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
      setState({ state: { status: 'model_unavailable' } });
      return;
    default: {
      const _ex: never = availability;
      throw new Error(`Unhandled Prompt API availability: ${_ex}`);
    }
    }
  } catch (error) {
    const normalized = normalizePromptApiError({ error });
    switch (normalized.code) {
    case 'api_unavailable':
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
  if (preparationPromise !== undefined) return preparationPromise;

  const run = async (): Promise<void> => {
    if (getPromptApiLanguageModel() === undefined) {
      setState({ state: { status: 'api_unavailable' } });
      throw new Error('LanguageModel API is unavailable.');
    }

    setState({ state: { status: 'preparing' } });

    let session: Awaited<ReturnType<typeof createPromptApiSession>> | undefined;
    try {
      session = await createPromptApiSession({
        initialPrompts: [],
        signal,
        onDownloadProgress: ({ progress }) => {
          setState({
            state: progress >= 1
              ? { status: 'preparing' }
              : { status: 'downloading', progress },
          });
        },
      });
      setState({ state: { status: 'ready' } });
    } catch (error) {
      const normalized = normalizePromptApiError({ error });
      switch (normalized.code) {
      case 'aborted':
        await refreshPromptApiAvailability({ showCheckingState: 'no' });
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
      throw normalized;
    } finally {
      session?.destroy();
    }
  };

  preparationPromise = run().finally(() => {
    preparationPromise = undefined;
  });
  return preparationPromise;
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

export const TEST_ONLY = {
  reset(): void {
    preparationPromise = undefined;
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
