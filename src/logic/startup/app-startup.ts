import { markRaw, nextTick, type ShallowRef } from 'vue';
import type { Router } from 'vue-router';
import type { useSettings } from '@/composables/useSettings';
import type { StartupState } from '@/logic/startup/types';
import {
  applyInitialGlobalSettingsQuery,
  installGlobalSettingsQuerySync,
} from '@/logic/settings/global-settings-query';
import { debugRecordFileProtocolStandaloneStartupCheckpoint } from '@/features/file-protocol-standalone/debug/startup';
import type { InitialNavigationGate } from '@/logic/startup/initial-navigation-gate';
import { createApplicationShellRenderGate } from './application-shell-render-gate';
import { waitForPresentationPaint } from '@/logic/startup/presentation-frame';
import {
  createOpfsEncryptionStartupGate,
  type OpfsEncryptionStartupGate,
} from './opfs-encryption-startup-gate';
import {
  readFirstQueryValue,
  resolveInitialRoute,
} from '@/logic/startup/startup-route';

type SettingsStore = ReturnType<typeof useSettings>;

export async function startApp({ startupState, settingsStore, router, navigationGate, window }: {
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
  let opfsEncryptionStartupGate: OpfsEncryptionStartupGate | undefined;

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
    onOpfsEncryptionAccessRequired: async ({ inspection }) => {
      const gate = createOpfsEncryptionStartupGate({ inspection });
      opfsEncryptionStartupGate = gate;
      startupState.value = {
        kind: 'opfs-encryption-required',
        gate,
      };
      await gate.wait();
    },
  });
  dataZipBase64 = undefined;

  const initialGlobalSettingsFingerprint = await applyInitialGlobalSettingsQuery({
    query: initialRoute.query,
    settingsStore,
  });

  startupState.value = opfsEncryptionStartupGate === undefined
    ? {
      kind: 'starting-main',
    }
    : {
      kind: 'starting-main-after-opfs-unlock',
      gate: opfsEncryptionStartupGate,
    };

  if (
    opfsEncryptionStartupGate === undefined
    && !settingsStore.isOnboardingDismissed.value
  ) {
    debugRecordFileProtocolStandaloneStartupCheckpoint({
      checkpoint: 'painting-onboarding',
      details: undefined,
    });

    /**
     * WHY: Plain first-run onboarding is latency-sensitive. Give its DOM one
     * paint of priority as soon as the plain Settings absence is known, then
     * continue loading the rest of the app in the background. Encrypted
     * startup intentionally skips this pause because the lock screen remains
     * the sole presentation until MainApp is ready.
     */
    await nextTick();
    await waitForPresentationPaint({ window });
  }

  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'loading-chats',
    details: undefined,
  });
  const chatStartupModule = await import('@/composables/chat/ui/useChatBootstrap');
  await chatStartupModule.loadChatsForAppStartup();

  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'loading-main-app',
    details: undefined,
  });
  const mainAppModule = await import('@/MainApp.vue');
  const mainApp = markRaw(mainAppModule.default);
  let applicationShellRenderGate: ReturnType<typeof createApplicationShellRenderGate> | undefined;

  if (opfsEncryptionStartupGate === undefined) {
    startupState.value = {
      kind: 'rendering-main',
      mainApp,
    };
  } else {
    applicationShellRenderGate = createApplicationShellRenderGate();
    startupState.value = {
      kind: 'rendering-main-after-opfs-unlock',
      gate: opfsEncryptionStartupGate,
      mainApp,
      renderGate: applicationShellRenderGate,
    };
  }

  /**
   * WHY: Mount the real main app before releasing route navigation so the
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

  if (applicationShellRenderGate !== undefined) {
    if (opfsEncryptionStartupGate === undefined) {
      throw new Error('Encrypted application render gate exists without an OPFS encryption startup gate');
    }

    /**
     * WHY: A successful passphrase check does not mean the application is
     * visually ready. MainApp explicitly reports after Sidebar, the initial
     * route's asynchronous preparation, and route-driven auxiliary UI such as
     * Settings Modal have completed their real first render. Only then do we
     * wait for a presentation paint and remove the lock. This avoids relying
     * on arbitrary frame counts while lazy components are still assembling.
     */
    await applicationShellRenderGate.waitForInitialRender();
    await nextTick();
    await waitForPresentationPaint({ window });

    /**
     * WHY: Application readiness and the unlock control's mechanical success
     * sequence are independent. Wait for both so a very fast app render cannot
     * remove the presentation halfway through the shutter's final seating
     * motion, while a slow app render may continue behind an already unlocked
     * control without adding an arbitrary delay.
     */
    await opfsEncryptionStartupGate.waitForUnlockPresentation();
  }

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
    mainApp,
  };
  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'app-ready',
    details: undefined,
  });
  return disposeGlobalSettingsQuerySync;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
