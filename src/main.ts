import { createApp, shallowRef } from 'vue';
import './style.css';
import App from './App.vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import { routes } from 'vue-router/auto-routes';
import { useSettings } from './composables/useSettings';
import { initializeThemeController } from './composables/useTheme';
import type { StartupState } from './models/startup';
import { scheduleFileProtocolStandaloneWorkerHubWarmup } from './services/worker-hub-standalone-loader';
import { scheduleAppBootstrap } from './services/app-bootstrap';
import {
  recordAppStartupFailure,
  reportAppStartupFailure,
} from './services/app-startup-failure';
import { startApp } from './services/startup/app-startup';
import { createInitialNavigationGate } from './services/startup/initial-navigation-gate';
import {
  debugRecordFileProtocolStandaloneStartupCheckpoint,
} from './services/debug-file-protocol-standalone/startup';

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
    const state = startupState.value;
    switch (state.kind) {
    case 'initializing-foundation':
      startupState.value = {
        kind: 'foundation-failed',
        error,
      };
      break;
    case 'starting-main':
    case 'rendering-main':
    case 'ready':
      startupState.value = {
        kind: 'main-failed',
        error,
      };
      break;
    case 'foundation-failed':
    case 'main-failed':
      break;
    default: {
      const _ex: never = state;
      throw new Error(`Unhandled startup state: ${JSON.stringify(_ex)}`);
    }
    }
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
