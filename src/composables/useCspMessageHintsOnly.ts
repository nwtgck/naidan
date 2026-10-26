import { onScopeDispose, readonly, shallowRef, watch } from 'vue';
import type { Ref } from 'vue';
import type { CspDeveloperSnapshot, CspHintMessage, CspHintTarget } from '@/logic/csp-message-hints/types';

type MessageModule = typeof import('@/logic/csp-message-hints');
let loading: Promise<MessageModule | undefined> | undefined;

function loadMessagesOnly(): Promise<MessageModule | undefined> {
  if (loading !== undefined) {
    return loading;
  }
  loading = new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(undefined);
    }, 3_000);
    void import('@/logic/csp-message-hints').then(module => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(module);
      }
    }, () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  });
  return loading;
}

/** Presentation only; no state or promise from here controls feature execution. */
export function useCspMessageHintsOnly({ target }: { target: Readonly<Ref<CspHintTarget | undefined>> }) {
  const message = shallowRef<CspHintMessage>();
  let disposed = false;
  let module: MessageModule | undefined;
  let unsubscribe: (() => void) | undefined;
  let loadingStarted = false;
  let observationStarted = false;
  function update(): void {
    try {
      const value = target.value;
      message.value = module?.describeCspForUiMessagesOnly({ target: value });
      if (value !== undefined) {
        if (module !== undefined && !observationStarted) {
          observationStarted = true;
          void module.ensureCspObservationForMessagesOnly().catch(() => undefined);
        } else if (!loadingStarted) {
          loadingStarted = true;
          void loadMessagesOnly().then(loaded => {
            if (disposed || loaded === undefined) {
              return;
            }
            const subscription = loaded.subscribeCspMessagesOnly({ listener: update });
            if (subscription === undefined) {
              message.value = undefined;
              return;
            }
            unsubscribe = subscription;
            module = loaded;
            update();
          }).catch(() => {
            message.value = undefined;
          });
        }
      }
    } catch {
      message.value = undefined;
    }
  }
  const stop = watch(() => {
    try {
      return target.value;
    } catch {
      return undefined;
    }
  }, update, { immediate: true });
  onScopeDispose(() => {
    disposed = true;
    stop();
    unsubscribe?.();
  });
  return readonly(message);
}

/** Only the dedicated Developer inspector may consume this raw cached state. */
export function useCachedCspParseResultForDeveloperDisplayOnly() {
  const snapshot = shallowRef<CspDeveloperSnapshot>(Object.freeze({
    observation: Object.freeze({ kind: 'not-started' }),
    addedMetaParsed: Object.freeze([]),
    connectionSummary: undefined,
  }));
  let disposed = false;
  let module: MessageModule | undefined;
  let unsubscribe: (() => void) | undefined;
  function update(): void {
    try {
      const value = module?.getCspDeveloperSnapshotForDisplayOnly();
      if (value !== undefined) {
        snapshot.value = value;
      }
    } catch {
      // Inspector failure cannot take down the surrounding Developer settings.
    }
  }
  void loadMessagesOnly().then(value => {
    if (disposed) {
      return;
    }
    if (value === undefined) {
      snapshot.value = Object.freeze({ ...snapshot.value, observation: Object.freeze({ kind: 'unavailable', reason: 'module-failed', capturedHeaders: undefined }) });
      return;
    }
    const subscription = value.subscribeCspMessagesOnly({ listener: update });
    if (subscription === undefined) {
      snapshot.value = Object.freeze({ ...snapshot.value, observation: Object.freeze({ kind: 'unavailable', reason: 'budget-exceeded', capturedHeaders: undefined }) });
      return;
    }
    unsubscribe = subscription;
    module = value;
    update();
    void module.ensureCspObservationForMessagesOnly().catch(() => undefined);
  }).catch(() => undefined);
  onScopeDispose(() => {
    disposed = true;
    unsubscribe?.();
  });
  return {
    snapshot: readonly(snapshot),
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
        // ESLint-required for useXxx return objects.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
