import { createApp, shallowRef } from 'vue';
import './style.css';
import App from './App.vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import { routes } from 'vue-router/auto-routes';
import { useSettings } from './composables/useSettings';
import { initializeThemeController } from './features/theme/composables/useTheme';
import type { StartupState } from './logic/startup/types';
import { scheduleFileProtocolStandaloneWorkerHubWarmup } from './features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import { scheduleAppBootstrap } from './logic/startup/app-bootstrap';
import {
  recordAppStartupFailure,
  reportAppStartupFailure,
} from './logic/startup/app-startup-failure';
import { startApp } from './logic/startup/app-startup';
import { createOpfsTransitionReloadGuard } from './logic/opfs-transition-reload-guard';
import { createInitialNavigationGate } from './logic/startup/initial-navigation-gate';
import { resolveStartupFailureState } from './logic/startup/startup-failure-state';
import {
  debugRecordFileProtocolStandaloneStartupCheckpoint,
} from './features/file-protocol-standalone/debug/startup';
import {
  registerOpfsStorageTransitionPreparation,
} from './00-storage/service/opfs/opfs-storage-transition-preparation';
import {
  installNativeOpfsPersistenceControlInspectionSource,
} from './features/debug-opfs-encryption/logic/native-opfs-persistence-control-inspection-source';
import {
  createActiveHizoFSPhysicalInspectionSource,
} from './features/debug-hizofs/logic/active-physical-inspection-source';
import {
  installHizoFSPhysicalInspectionSource,
} from './features/debug-hizofs/composables/useDebugHizoFSWorkbench';
import {
  openActiveAuthenticatedHizoFSContainerLocationLease,
} from './00-storage/service/naidan-opfs/active-hizofs-container-location';
import {
  installDevelopmentUnverifiedOpfsPersistenceRuntime,
} from './00-storage/service/naidan-opfs/development-persistence-runtime';

installDevelopmentUnverifiedOpfsPersistenceRuntime();

const opfsTransitionReloadGuard = createOpfsTransitionReloadGuard({ document, window });

installNativeOpfsPersistenceControlInspectionSource();
installHizoFSPhysicalInspectionSource({
  source: createActiveHizoFSPhysicalInspectionSource({
    openLease: openActiveAuthenticatedHizoFSContainerLocationLease,
  }),
});

registerOpfsStorageTransitionPreparation({
  localTransitionStarting: () => {
    opfsTransitionReloadGuard.markTransitionStarted();
  },
  externalTransitionStarting: async () => {
    opfsTransitionReloadGuard.markTransitionStarted();
    const transitionPresentation = await import(
      './features/opfs-encryption/composables/useOpfsEncryptionTransition'
    );
    transitionPresentation.useOpfsEncryptionTransition().beginExternalOperation();
  },
  prepare: async () => {
    const transitionPreparation = await import(
      './features/opfs-encryption/prepare-for-storage-transition'
    );
    await transitionPreparation.prepareForOpfsEncryptionTransition();
  },
  localTransitionSettled: ({ settlement }) => {
    console.info('[opfs-encryption]', {
      event: 'local_transition_settled',
      settlement,
      action: 'reload',
    });
    opfsTransitionReloadGuard.reloadAfterSettlement();
  },
  externalTransitionSettled: ({ settlement }) => {
    console.info('[opfs-encryption]', {
      event: 'external_transition_settled',
      settlement,
      action: 'reload',
    });
    opfsTransitionReloadGuard.reloadAfterSettlement();
  },
});

async function bootstrapApp(): Promise<void> {
  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'bootstrapping',
    details: undefined,
  });

  const appElement = document.querySelector('#app');
  if (appElement === null) {
    throw new Error('The #app mount element is missing.');
  }

  // The document bootstrap has already painted the saved theme. Initialize the
  // single reactive owner before mounting so onboarding never falls back to a
  // different theme while the normal app remains deferred.
  initializeThemeController({ window, document });

  const startupState = shallowRef<StartupState>({
    kind: 'initializing-foundation',
  });
  const router = createRouter({
    history: createWebHashHistory(),
    routes,
  });
  const navigationGate = createInitialNavigationGate({ router });
  const app = createApp(App, {
    startupState,
  });

  // Keep this assignment visible: it reports unhandled Vue rendering and
  // lifecycle errors in both hosted and standalone builds.
  app.config.errorHandler = (error, instance, info) => {
    console.error('Vue Error:', error);
    console.error('Vue Instance:', instance);
    console.error('Error Info:', info);
  };

  app.use(router);

  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'mounting-vue',
    details: undefined,
  });
  app.mount(appElement);
  debugRecordFileProtocolStandaloneStartupCheckpoint({
    checkpoint: 'app-mounted',
    details: undefined,
  });

  try {
    await startApp({
      startupState,
      settingsStore: useSettings(),
      router,
      navigationGate,
      window,
    });
  } catch (error) {
    recordAppStartupFailure({ error });
    startupState.value = resolveStartupFailureState({
      state: startupState.value,
      error,
    });
    return;
  }

  if (__BUILD_MODE_IS_STANDALONE__) {
    scheduleFileProtocolStandaloneWorkerHubWarmup();
  }
}

debugRecordFileProtocolStandaloneStartupCheckpoint({
  checkpoint: 'entry-evaluated',
  details: undefined,
});
scheduleAppBootstrap({
  document,
  bootstrap: bootstrapApp,
  onWaitingForDom: () => {
    debugRecordFileProtocolStandaloneStartupCheckpoint({
      checkpoint: 'waiting-dom',
      details: undefined,
    });
  },
  onFailure: ({ error }) => {
    reportAppStartupFailure({ document, error });
  },
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
