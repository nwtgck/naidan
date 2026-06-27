import { markRaw, nextTick, type ShallowRef } from 'vue';
import type { Router } from 'vue-router';
import type { useSettings } from '@/composables/useSettings';
import type { StartupState } from '@/models/startup';
import {
  applyInitialGlobalSettingsQuery,
  installGlobalSettingsQuerySync,
} from '@/services/global-settings-query';
import { debugRecordFileProtocolStandaloneStartupCheckpoint } from '@/services/debug-file-protocol-standalone/startup';
import type { InitialNavigationGate } from '@/services/startup/initial-navigation-gate';
import {
  waitForTwoAnimationFrames,
  waitUntilOnboardingDismissed,
} from '@/services/startup/onboarding-wait';
import {
  readFirstQueryValue,
  resolveInitialRoute,
} from '@/services/startup/startup-route';

type SettingsStore = ReturnType<typeof useSettings>;

function enterStartingMain({ state }: {
  state: StartupState,
}): Extract<StartupState, { kind: 'starting-main' }> {
  switch (state.kind) {
  case 'initializing':
    return {
      kind: 'starting-main',
      mainLayout: 'preview-not-rendered',
    };
  case 'waiting-for-onboarding':
    return {
      kind: 'starting-main',
      mainLayout: state.mainLayout,
    };
  case 'starting-main':
  case 'ready':
  case 'error':
    throw new Error(`Cannot start the main application from startup state: ${state.kind}`);
  default: {
    const _ex: never = state;
    return _ex;
  }
  }
}

async function revealMainLayoutPreviewAfterOnboardingPaint({ startupState, settingsStore, window }: {
  startupState: ShallowRef<StartupState>,
  settingsStore: SettingsStore,
  window: Pick<Window, 'requestAnimationFrame'>,
}): Promise<void> {
  await nextTick();
  await waitForTwoAnimationFrames({ window });

  if (settingsStore.isOnboardingDismissed.value) return;
  const state = startupState.value;
  switch (state.kind) {
  case 'waiting-for-onboarding':
    switch (state.mainLayout) {
    case 'preview-not-rendered':
      break;
    case 'preview-rendered':
      return;
    default: {
      const _ex: never = state.mainLayout;
      return _ex;
    }
    }
    break;
  case 'initializing':
  case 'starting-main':
  case 'ready':
  case 'error':
    return;
  default: {
    const _ex: never = state;
    return _ex;
  }
  }

  /**
   * WHY: The background preview helps users predict what closing onboarding
   * reveals, but onboarding itself is the only required UI at this point. Two
   * paints give the modal first priority so the preview cannot reintroduce the
   * measured startup delay we are removing.
   */
  startupState.value = {
    kind: 'waiting-for-onboarding',
    mainLayout: 'preview-rendered',
  };
}

export async function startApplication({ startupState, settingsStore, router, navigationGate, window }: {
  startupState: ShallowRef<StartupState>,
  settingsStore: SettingsStore,
  router: Router,
  navigationGate: InitialNavigationGate,
  window: Window,
}): Promise<() => void> {
  const initialRoute = resolveInitialRoute({ router });
  const storageTypeOverride = readFirstQueryValue({
    value: initialRoute.query['storage-type'],
  });

  let dataZipBase64 = readFirstQueryValue({
    value: initialRoute.query['data-zip'],
  });

  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'initializing-settings',
    details: {
      hasStorageTypeOverride: storageTypeOverride !== undefined,
      hasDataZip: dataZipBase64 !== undefined,
    },
  });
  await settingsStore.init({
    storageTypeOverride,
    dataZipBase64,
  });
  dataZipBase64 = undefined;

  const initialGlobalSettingsFingerprint = await applyInitialGlobalSettingsQuery({
    query: initialRoute.query,
    settingsStore,
  });

  if (!settingsStore.isOnboardingDismissed.value) {
    startupState.value = {
      kind: 'waiting-for-onboarding',
      mainLayout: 'preview-not-rendered',
    };
    debugRecordFileProtocolStandaloneStartupCheckpoint({
      checkpoint: 'waiting-onboarding',
      details: undefined,
    });

    /**
     * WHY: Profiling showed that loading the normal route before onboarding was
     * the dominant delay. We therefore wait only for the existing onboarding
     * state to become dismissed, then rejoin the same normal startup path used
     * by configured users. The preview task is deliberately fire-and-forget so
     * it can never delay a fast close action.
     */
    void revealMainLayoutPreviewAfterOnboardingPaint({
      startupState,
      settingsStore,
      window,
    });

    await waitUntilOnboardingDismissed({
      isOnboardingDismissed: settingsStore.isOnboardingDismissed,
    });
  }

  startupState.value = enterStartingMain({
    state: startupState.value,
  });

  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'loading-chats',
    details: undefined,
  });
  const { useChatBootstrap } = await import('@/composables/chat/ui/useChatBootstrap');
  await useChatBootstrap().loadChats();

  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'loading-main-application',
    details: undefined,
  });
  const appModule = await import('@/App.vue');

  navigationGate.release();
  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'waiting-router',
    details: undefined,
  });
  await router.isReady();

  const disposeGlobalSettingsQuerySync = installGlobalSettingsQuerySync({
    router,
    settingsStore,
    initialFingerprint: initialGlobalSettingsFingerprint,
  });

  const dataZipQuery = router.currentRoute.value.query['data-zip'];
  if (readFirstQueryValue({ value: dataZipQuery }) !== undefined) {
    const query = { ...router.currentRoute.value.query };
    delete query['data-zip'];
    void router.replace({ query });
  }

  startupState.value = {
    kind: 'ready',
    mainApplication: markRaw(appModule.default),
  };
  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'mounted',
    details: undefined,
  });
  return disposeGlobalSettingsQuerySync;
}
