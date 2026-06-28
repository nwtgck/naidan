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
import { waitForPresentationPaint } from '@/services/startup/presentation-frame';
import {
  readFirstQueryValue,
  resolveInitialRoute,
} from '@/services/startup/startup-route';

type SettingsStore = ReturnType<typeof useSettings>;

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

  startupState.value = {
    kind: 'starting-main',
  };

  if (!settingsStore.isOnboardingDismissed.value) {
    debugRecordFileProtocolStandaloneStartupCheckpoint({
      checkpoint: 'waiting-onboarding',
      details: undefined,
    });

    /**
     * WHY: Onboarding is a presentation interruption, not a startup gate. Give
     * its DOM one paint of priority, then continue the exact same main startup
     * path while the modal remains visible.
     */
    await nextTick();
    await waitForPresentationPaint({ window });
  }

  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'loading-chats',
    details: undefined,
  });
  const chatStartupModule = await import('@/composables/chat/ui/useChatBootstrap');
  await chatStartupModule.loadChatsForApplicationStartup();

  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'loading-main-application',
    details: undefined,
  });
  const appModule = await import('@/App.vue');
  const mainApplication = markRaw(appModule.default);

  startupState.value = {
    kind: 'rendering-main',
    mainApplication,
  };

  /**
   * WHY: Mount the real application before releasing route navigation so the
   * real Sidebar can paint first. Interaction remains blocked until the router
   * is ready, preventing START_LOCATION from triggering normal commands.
   */
  await nextTick();
  await waitForPresentationPaint({ window });

  chatStartupModule.useChatBootstrap();
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
    mainApplication,
  };
  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'mounted',
    details: undefined,
  });
  return disposeGlobalSettingsQuerySync;
}
