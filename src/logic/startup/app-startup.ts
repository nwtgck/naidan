import { markRaw, nextTick, watch, type Component, type ShallowRef } from 'vue';
import type { Router } from 'vue-router';
import type { useSettings } from '@/composables/useSettings';
import type { StartupState } from '@/logic/startup/types';
import {
  applyInitialGlobalSettingsQuery,
  installGlobalSettingsQuerySync,
} from '@/logic/settings/global-settings-query';
import { debugRecordFileProtocolStandaloneStartupCheckpoint } from '@/features/file-protocol-standalone/debug/startup';
import type { InitialNavigationGate } from '@/logic/startup/initial-navigation-gate';
import { waitForPresentationPaint } from '@/logic/startup/presentation-frame';
import { hasModelEntryQuery, hasSelectedGlobalChatModel, resolveAppEntryKind, shouldDeferInitialModelRefresh } from '@/logic/startup/entry-intent';
import { currentLocale, prepareLocale } from '@/strings';
import { getActiveAppEntry } from '@/composables/useAppEntry';
import { startRpcAutomaticConnections } from '@/features/naidan-rpc-integration/runtime/feature';
import { storageService } from '@/00-storage/service';
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
  const modelEntry = hasModelEntryQuery({ query: initialRoute.query });
  const storageTypeOverride = modelEntry ? undefined : readFirstQueryValue({
    value: initialRoute.query['storage-type'],
  });

  let dataZipBase64 = modelEntry ? undefined : readFirstQueryValue({
    value: initialRoute.query['data-zip'],
  });
  const acceptedDataZip = dataZipBase64 ? { fullPath: initialRoute.fullPath, value: dataZipBase64 } : undefined;

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
    modelRefresh: shouldDeferInitialModelRefresh({ route: initialRoute }) ? 'deferred' : 'background',
  });
  dataZipBase64 = undefined;

  const initialGlobalSettingsFingerprint = await applyInitialGlobalSettingsQuery({
    query: resolveInitialRoute({ router }).query,
    settingsStore,
  });

  const entryKind = resolveAppEntryKind({ route: resolveInitialRoute({ router }), initialized: true });
  const initialHome = (() => {
    switch (entryKind) {
    case 'home': return true;
    case 'model-preview':
    case 'pending':
    case 'ordinary': return false;
    default: {
      const exhaustive: never = entryKind;
      throw new Error(`Unhandled initial history entry: ${String(exhaustive)}`);
    }
    }
  })();
  let initialSidebarCurrent = true;
  const stopInitialSidebarWatch = initialHome ? storageService.subscribeToChanges({
    listener: ({ event }) => {
      if (event.type === 'chat_meta_and_chat_group' || event.type === 'migration') {
        initialSidebarCurrent = false;
      }
    },
  }) : () => {};
  let entrySurface: Component | undefined;
  let chatStartupModule: typeof import('@/composables/chat/ui/useChatBootstrap');
  try {
    // Read metadata only; do not evaluate the chat runtime before the initial
    // dialog's paint. Reuse this sidebar snapshot during the later bootstrap.
    const initialSidebar = initialHome ? await storageService.getSidebarStructure() : undefined;
    getActiveAppEntry()?.initializeHomePresentation({ empty: initialSidebar?.length === 0 });

    startupState.value = {
      kind: 'starting-main',
    };

    switch (entryKind) {
    case 'home': {
      if (initialSidebar?.length !== 0) {
        settingsStore.resumeModelRefresh();
        break;
      }
      settingsStore.deferModelRefresh();
      // App synchronously owns the initial dialog and cards. Give their strings,
      // DOM and paint priority before importing chat bootstrap or MainApp.
      await prepareLocale({ locale: currentLocale.value });
      debugRecordFileProtocolStandaloneStartupCheckpoint({ checkpoint: 'painting-onboarding', details: undefined });
      await nextTick();
      await waitForPresentationPaint({ window });
      break;
    }
    case 'model-preview': {
      settingsStore.deferModelRefresh();
      const module = await import('@/components/AppEntrySurface.vue');
      await prepareLocale({ locale: currentLocale.value });
      entrySurface = markRaw(module.default);
      startupState.value = { kind: 'starting-main', entrySurface };
      debugRecordFileProtocolStandaloneStartupCheckpoint({
        checkpoint: 'painting-onboarding',
        details: undefined,
      });

      /**
       * Paint the passive entry before evaluating the main chat graph. Interaction
       * still follows the normal startup gate; no early action is queued.
       */
      await nextTick();
      await waitForPresentationPaint({ window });
      break;
    }
    case 'pending':
    case 'ordinary':
      settingsStore.resumeModelRefresh();
      break;
    default: {
      const _ex: never = entryKind;
      throw new Error(`Unhandled startup entry: ${String(_ex)}`);
    }
    }

    debugRecordFileProtocolStandaloneStartupCheckpoint({
      checkpoint: 'loading-chats',
      details: undefined,
    });
    chatStartupModule = await import('@/composables/chat/ui/useChatBootstrap');
    await chatStartupModule.loadChatsForAppStartup({ initialSidebar: initialSidebarCurrent ? initialSidebar : undefined });
  } finally {
    stopInitialSidebarWatch();
  }

  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'loading-main-app',
    details: undefined,
  });
  const mainAppModule = await import('@/MainApp.vue');
  const mainApp = markRaw(mainAppModule.default);

  startupState.value = {
    kind: 'rendering-main',
    mainApp,
    ...(entrySurface === undefined ? {} : { entrySurface }),
  };

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

  const disposeGlobalSettingsQuerySync = installGlobalSettingsQuerySync({
    router,
    settingsStore,
    initialFingerprint: initialGlobalSettingsFingerprint,
  });

  const dataZipQuery = router.currentRoute.value.query['data-zip'];
  if (acceptedDataZip !== undefined && router.currentRoute.value.fullPath === acceptedDataZip.fullPath
    && !hasModelEntryQuery({ query: router.currentRoute.value.query })
    && readFirstQueryValue({ value: dataZipQuery }) === acceptedDataZip.value) {
    const query = { ...router.currentRoute.value.query };
    delete query['data-zip'];
    await router.replace({ query });
  }

  startupState.value = {
    kind: 'ready',
    mainApp,
  };
  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'app-ready',
    details: undefined,
  });
  let disposeRpcAutomaticConnections: (() => void) | undefined;
  const appEntry = getActiveAppEntry();
  const disposeAutomaticActivity = watch(
    () => appEntry?.automaticActivity.value ?? (hasModelEntryQuery({ query: router.currentRoute.value.query })
      || (router.currentRoute.value.path === '/' && entryKind === 'home' && !hasSelectedGlobalChatModel({ settings: settingsStore.settings.value })) ? 'deferred' : 'ordinary'),
    activity => {
      switch (activity) {
      case 'deferred':
        settingsStore.deferModelRefresh();
        return;
      case 'ordinary':
        settingsStore.resumeModelRefresh();
        disposeRpcAutomaticConnections ??= startRpcAutomaticConnections();
        return;
      default: {
        const _ex: never = activity;
        throw new Error(`Unhandled automatic activity: ${String(_ex)}`);
      }
      }
    },
    { immediate: true, flush: 'sync' },
  );
  return () => {
    disposeAutomaticActivity();
    disposeRpcAutomaticConnections?.();
    disposeGlobalSettingsQuerySync();
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
