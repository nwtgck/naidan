import { flushPromises } from '@vue/test-utils';
import { defineComponent, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { useSettings } from '@/composables/useSettings';
import type { Settings } from '@/01-models/types';
import type { StartupState } from '@/logic/startup/types';
import { createInitialNavigationGate } from '@/logic/startup/initial-navigation-gate';
import { startApp } from './app-startup';

const MainApp = defineComponent({
  template: '<div />',
});
const loadChatsForAppStartup = vi.hoisted(() => vi.fn(async () => {}));
const activateChatBootstrap = vi.hoisted(() => vi.fn());

vi.mock('@/MainApp.vue', () => ({
  default: MainApp,
}));

vi.mock('@/composables/chat/ui/useChatBootstrap', () => ({
  loadChatsForAppStartup,
  useChatBootstrap: () => {
    activateChatBootstrap();
    return {
      loadChats: loadChatsForAppStartup,
      openChat: async () => undefined,
      TEST_ONLY: {},
    };
  },
}));

vi.mock('@/features/file-protocol-standalone/debug/startup', () => ({
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
    if (patch.endpoint !== undefined && patch.defaultModelId !== undefined) {
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
    kind: 'initializing-foundation',
  });
  const animationFrameCallbacks: FrameRequestCallback[] = [];
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    animationFrameCallbacks.push(callback);
    return animationFrameCallbacks.length;
  });

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

function flushAnimationFrame({ callbacks, timestamp }: {
  callbacks: FrameRequestCallback[],
  timestamp: number,
}): void {
  const callback = callbacks.shift();
  if (callback === undefined) {
    throw new Error('Expected a pending animation frame.');
  }
  callback(timestamp);
}

function flushPresentationPaint({ callbacks }: {
  callbacks: FrameRequestCallback[],
}): void {
  flushAnimationFrame({ callbacks, timestamp: 0 });
  flushAnimationFrame({ callbacks, timestamp: 16 });
}

describe('app startup', () => {
  beforeEach(() => {
    loadChatsForAppStartup.mockClear();
    activateChatBootstrap.mockClear();
  });

  it('uses the normal main startup path for an already configured user', async () => {
    const settings = createSettingsStore({ onboardingDismissed: true });
    const harness = createStartupHarness();

    const startup = startApp({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();

    expect(settings.init).toHaveBeenCalledOnce();
    expect(loadChatsForAppStartup).toHaveBeenCalledOnce();
    expect(harness.startupState.value).toEqual({
      kind: 'rendering-main',
      mainApp: MainApp,
    });
    expect(harness.loadRouteComponent).not.toHaveBeenCalled();

    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;

    expect(activateChatBootstrap).toHaveBeenCalledOnce();
    expect(harness.loadRouteComponent).toHaveBeenCalledOnce();
    expect(harness.startupState.value).toEqual({
      kind: 'ready',
      mainApp: MainApp,
    });

    dispose();
  });

  it('gives onboarding one paint and then renders the real app before dismissal', async () => {
    const settings = createSettingsStore({ onboardingDismissed: false });
    const harness = createStartupHarness();

    const startup = startApp({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();

    expect(harness.startupState.value).toEqual({
      kind: 'starting-main',
    });
    expect(loadChatsForAppStartup).not.toHaveBeenCalled();
    expect(harness.animationFrameCallbacks).toHaveLength(1);

    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    await flushPromises();

    expect(settings.isOnboardingDismissed.value).toBe(false);
    expect(loadChatsForAppStartup).toHaveBeenCalledOnce();
    expect(harness.startupState.value).toEqual({
      kind: 'rendering-main',
      mainApp: MainApp,
    });
    expect(harness.loadRouteComponent).not.toHaveBeenCalled();

    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;

    expect(settings.isOnboardingDismissed.value).toBe(false);
    expect(activateChatBootstrap).toHaveBeenCalledOnce();
    expect(harness.loadRouteComponent).toHaveBeenCalledOnce();
    expect(harness.startupState.value).toEqual({
      kind: 'ready',
      mainApp: MainApp,
    });

    dispose();
  });

  it('passes startup storage data once and removes only the transient data zip query', async () => {
    const settings = createSettingsStore({ onboardingDismissed: true });
    const harness = createStartupHarness({
      path: '/?storage-type=opfs&data-zip=encoded-state',
    });

    const startup = startApp({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();
    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;
    await flushPromises();

    expect(settings.init).toHaveBeenCalledWith({
      storageTypeOverride: 'opfs',
      dataZipBase64: 'encoded-state',
    });
    expect(harness.router.currentRoute.value.query['data-zip']).toBeUndefined();
    expect(harness.router.currentRoute.value.query['storage-type']).toBe('opfs');

    dispose();
  });

  it('preserves the initial deep link while delaying its component load until the real Sidebar can paint', async () => {
    const settings = createSettingsStore({ onboardingDismissed: true });
    const harness = createStartupHarness({
      path: '/chat/chat-1?leaf=message-2',
    });

    const startup = startApp({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();

    expect(harness.startupState.value.kind).toBe('rendering-main');
    expect(harness.loadRouteComponent).not.toHaveBeenCalled();

    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;

    expect(harness.router.currentRoute.value.path).toBe('/chat/chat-1');
    expect(harness.router.currentRoute.value.query.leaf).toBe('message-2');
    expect(harness.loadRouteComponent).toHaveBeenCalledOnce();

    dispose();
  });

  it('applies initial URL settings before deciding whether onboarding needs paint priority', async () => {
    const settings = createSettingsStore({ onboardingDismissed: false });
    const harness = createStartupHarness({
      path: '/?global-endpoint-type=ollama&global-endpoint-url=http%3A%2F%2Flocalhost%3A11434&global-model=llama3',
    });

    const startup = startApp({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();

    expect(settings.save).toHaveBeenCalledWith({
      patch: {
        endpoint: { type: 'ollama', url: 'http://localhost:11434' },
        defaultModelId: 'llama3',
      },
      modelRefresh: 'background',
    });
    expect(harness.animationFrameCallbacks).toHaveLength(1);
    expect(harness.startupState.value.kind).toBe('rendering-main');

    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;
    expect(harness.startupState.value.kind).toBe('ready');

    dispose();
  });
});
