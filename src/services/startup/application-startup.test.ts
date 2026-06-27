import { flushPromises } from '@vue/test-utils';
import { defineComponent, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { useSettings } from '@/composables/useSettings';
import type { Settings } from '@/models/types';
import type { StartupState } from '@/models/startup';
import { createInitialNavigationGate } from '@/services/startup/initial-navigation-gate';
import { startApplication } from './application-startup';

const MainApplication = defineComponent({
  template: '<div />',
});
const loadChats = vi.fn(async () => {});

vi.mock('@/App.vue', () => ({
  default: MainApplication,
}));

vi.mock('@/composables/chat/ui/useChatBootstrap', () => ({
  useChatBootstrap: () => ({ loadChats }),
}));

vi.mock('@/services/debug-file-protocol-standalone/startup', () => ({
  debugRecordFileProtocolStandaloneStartupCheckpoint: vi.fn(),
}));

type SettingsStore = ReturnType<typeof useSettings>;

function createSettingsStore({ onboardingDismissed }: {
  onboardingDismissed: boolean,
}) {
  const isOnboardingDismissed = ref(onboardingDismissed);
  const init = vi.fn(async () => {});
  const save = vi.fn(async ({ patch }: {
    patch: Partial<Settings>,
  }) => {
    if (patch.endpointUrl !== undefined && patch.defaultModelId !== undefined) {
      isOnboardingDismissed.value = true;
    }
  });

  return {
    init,
    isOnboardingDismissed,
    save,
    settingsStore: {
      init,
      isOnboardingDismissed,
      save,
    } as unknown as SettingsStore,
  };
}

function createStartupHarness({ path = '/' }: {
  path?: string,
} = {}) {
  const history = createMemoryHistory();
  history.replace(path);
  const loadRouteComponent = vi.fn(async () => ({
    template: '<div />',
  }));
  const router = createRouter({
    history,
    routes: [
      { path: '/', component: loadRouteComponent },
      { path: '/chat/:id', component: loadRouteComponent },
    ],
  });
  const navigationGate = createInitialNavigationGate({ router });
  const startupState = shallowRef<StartupState>({
    kind: 'initializing',
  });
  const animationFrameCallbacks: FrameRequestCallback[] = [];
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    animationFrameCallbacks.push(callback);
    return animationFrameCallbacks.length;
  });

  // Vue Router normally starts this navigation from app.use(router). Starting
  // it explicitly keeps this test focused on the startup gate without mounting
  // another Vue application.
  void router.push(history.location);

  return {
    animationFrameCallbacks,
    loadRouteComponent,
    navigationGate,
    router,
    startupState,
    window: {
      requestAnimationFrame,
    } as unknown as Window,
  };
}

describe('application startup', () => {
  beforeEach(() => {
    loadChats.mockClear();
  });

  it('uses the same single main startup path for an already configured user', async () => {
    const settings = createSettingsStore({ onboardingDismissed: true });
    const harness = createStartupHarness();

    const dispose = await startApplication({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });

    expect(settings.init).toHaveBeenCalledOnce();
    expect(loadChats).toHaveBeenCalledOnce();
    expect(harness.loadRouteComponent).toHaveBeenCalledOnce();
    expect(harness.startupState.value).toEqual({
      kind: 'ready',
      mainApplication: MainApplication,
    });

    dispose();
  });

  it('does not initialize the main application until onboarding closes', async () => {
    const settings = createSettingsStore({ onboardingDismissed: false });
    const harness = createStartupHarness();

    const startup = startApplication({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();

    expect(harness.startupState.value).toEqual({
      kind: 'waiting-for-onboarding',
      mainLayout: 'preview-not-rendered',
    });
    expect(loadChats).not.toHaveBeenCalled();
    expect(harness.loadRouteComponent).not.toHaveBeenCalled();

    settings.isOnboardingDismissed.value = true;
    const dispose = await startup;

    expect(loadChats).toHaveBeenCalledOnce();
    expect(harness.loadRouteComponent).toHaveBeenCalledOnce();
    expect(harness.startupState.value).toEqual({
      kind: 'ready',
      mainApplication: MainApplication,
    });

    dispose();
  });

  it('renders the main layout preview only after onboarding receives two paints', async () => {
    const settings = createSettingsStore({ onboardingDismissed: false });
    const harness = createStartupHarness();

    const startup = startApplication({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();

    expect(harness.animationFrameCallbacks).toHaveLength(1);
    expect(harness.startupState.value).toEqual({
      kind: 'waiting-for-onboarding',
      mainLayout: 'preview-not-rendered',
    });

    harness.animationFrameCallbacks.shift()!(0);
    expect(harness.animationFrameCallbacks).toHaveLength(1);
    harness.animationFrameCallbacks.shift()!(0);
    await flushPromises();

    expect(harness.startupState.value).toEqual({
      kind: 'waiting-for-onboarding',
      mainLayout: 'preview-rendered',
    });

    settings.isOnboardingDismissed.value = true;
    const dispose = await startup;
    dispose();
  });

  it('passes startup storage data once and removes only the transient data zip query', async () => {
    const settings = createSettingsStore({ onboardingDismissed: true });
    const harness = createStartupHarness({
      path: '/?storage-type=opfs&data-zip=encoded-state',
    });

    const dispose = await startApplication({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();

    expect(settings.init).toHaveBeenCalledWith({
      storageTypeOverride: 'opfs',
      dataZipBase64: 'encoded-state',
    });
    expect(harness.router.currentRoute.value.query['data-zip']).toBeUndefined();
    expect(harness.router.currentRoute.value.query['storage-type']).toBe('opfs');

    dispose();
  });

  it('preserves the initial deep link while delaying its component load', async () => {
    const settings = createSettingsStore({ onboardingDismissed: true });
    const harness = createStartupHarness({
      path: '/chat/chat-1?leaf=message-2',
    });

    const dispose = await startApplication({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });

    expect(harness.router.currentRoute.value.path).toBe('/chat/chat-1');
    expect(harness.router.currentRoute.value.query.leaf).toBe('message-2');
    expect(harness.loadRouteComponent).toHaveBeenCalledOnce();

    dispose();
  });

  it('applies initial URL settings before deciding whether onboarding is needed', async () => {
    const settings = createSettingsStore({ onboardingDismissed: false });
    const harness = createStartupHarness({
      path: '/?global-endpoint-type=ollama&global-endpoint-url=http%3A%2F%2Flocalhost%3A11434&global-model=llama3',
    });

    const dispose = await startApplication({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });

    expect(settings.save).toHaveBeenCalledWith({
      patch: {
        endpointType: 'ollama',
        endpointUrl: 'http://localhost:11434',
        defaultModelId: 'llama3',
      },
      modelRefresh: 'background',
    });
    expect(loadChats).toHaveBeenCalledOnce();
    expect(harness.startupState.value.kind).toBe('ready');

    dispose();
  });
});
