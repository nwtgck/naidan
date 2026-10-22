import { flushPromises } from '@vue/test-utils';
import { defineComponent, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { useSettings } from '@/composables/useSettings';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import type { StartupState } from '@/logic/startup/types';
import { createInitialNavigationGate } from '@/logic/startup/initial-navigation-gate';
import { startApp } from './app-startup';

const MainApp = defineComponent({
  template: '<div />',
});
const loadChatsForAppStartup = vi.hoisted(() => vi.fn(async () => {}));
const activateChatBootstrap = vi.hoisted(() => vi.fn());
const disposeRpcAutomaticConnections = vi.hoisted(() => vi.fn());
const startRpcAutomaticConnections = vi.hoisted(() => vi.fn(() => disposeRpcAutomaticConnections));
vi.mock('@/features/naidan-rpc-integration/runtime/feature', () => ({ startRpcAutomaticConnections }));

vi.mock('@/composables/useAppEntry', () => ({ getActiveAppEntry: () => undefined }));
const EntrySurface = defineComponent({ template: '<div />' });
vi.mock('@/components/AppEntrySurface.vue', () => ({ default: EntrySurface }));

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
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS, storageType: 'memory', endpoint: onboardingDismissed ? { type: 'llama_cpp_browser' } : { type: 'openai', url: '' }, defaultModelId: onboardingDismissed ? 'selected-model' : undefined });
  const init = vi.fn(async () => {});
  const deferModelRefresh = vi.fn();
  const resumeModelRefresh = vi.fn();
  const save = vi.fn(async ({ patch }: {
    patch: Partial<Settings>,
  }) => {
    settings.value = { ...settings.value, ...patch };
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
      settings,
      deferModelRefresh,
      resumeModelRefresh,
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
      { path: '/image-generation', component: loadRouteComponent },
      { path: '/image-generation/models', component: loadRouteComponent },
      { path: '/audio-generation', component: loadRouteComponent },
      { path: '/audio-generation/voices', component: loadRouteComponent },
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
    startRpcAutomaticConnections.mockClear();
    disposeRpcAutomaticConnections.mockClear();
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
    expect(startRpcAutomaticConnections).not.toHaveBeenCalled();

    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;

    expect(activateChatBootstrap).toHaveBeenCalledOnce();
    expect(harness.loadRouteComponent).toHaveBeenCalledOnce();
    expect(harness.startupState.value).toEqual({
      kind: 'ready',
      mainApp: MainApp,
    });

    dispose();
    expect(startRpcAutomaticConnections).toHaveBeenCalledOnce();
    expect(disposeRpcAutomaticConnections).toHaveBeenCalledOnce();
  });

  it.each([
    '/image-generation',
    '/image-generation/models',
    '/audio-generation',
    '/audio-generation/voices',
  ])('skips the onboarding-only paint for the initial %s route', async path => {
    const settings = createSettingsStore({ onboardingDismissed: false });
    const harness = createStartupHarness({ path });
    const startup = startApp({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();

    expect(settings.isOnboardingDismissed.value).toBe(false);
    expect(loadChatsForAppStartup).toHaveBeenCalledOnce();
    expect(harness.startupState.value.kind).toBe('rendering-main');
    expect(harness.animationFrameCallbacks).toHaveLength(1);

    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;
    expect(harness.router.currentRoute.value.path).toBe(path);
    expect(harness.startupState.value.kind).toBe('ready');
    dispose();
  });

  it('paints the passive entry before loading the real main app', async () => {
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
      entrySurface: EntrySurface,
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
      entrySurface: EntrySurface,
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
      modelRefresh: 'deferred',
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

  it('applies initial URL settings before deciding whether the passive entry needs paint priority', async () => {
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

  it.each(['owner/repo', '', 'owner/a&llama-cpp-browser-model=owner/b'])('keeps a model preview URL unchanged and suppresses every other startup query: %s', async input => {
    const settings = createSettingsStore({ onboardingDismissed: true });
    const harness = createStartupHarness({ path: `/chat/existing?llama-cpp-browser-model=${input}&storage-type=memory&data-zip=ignored&global-model=ignored&settings=storage&q=ignored` });
    const expectedPath = harness.router.resolve(harness.router.options.history.location).fullPath;
    const replace = vi.spyOn(harness.router, 'replace');
    const startup = startApp({ startupState: harness.startupState, settingsStore: settings.settingsStore, router: harness.router, navigationGate: harness.navigationGate, window: harness.window });
    await flushPromises();
    expect(loadChatsForAppStartup).not.toHaveBeenCalled();
    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    await flushPromises();
    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;
    using _startup = { [Symbol.dispose]: dispose };
    expect(settings.init).toHaveBeenCalledWith({ storageTypeOverride: undefined, dataZipBase64: undefined, modelRefresh: 'deferred' });
    expect(settings.save).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(harness.router.currentRoute.value.fullPath).toBe(expectedPath);
    expect(startRpcAutomaticConnections).not.toHaveBeenCalled();
  });

  it('never removes data belonging to a newer navigation from an older startup cleanup', async () => {
    const settings = createSettingsStore({ onboardingDismissed: true });
    const harness = createStartupHarness({ path: '/?data-zip=accepted' });
    const startup = startApp({ startupState: harness.startupState, settingsStore: settings.settingsStore, router: harness.router, navigationGate: harness.navigationGate, window: harness.window });
    const navigation = harness.router.push('/chat/other?data-zip=unprocessed');
    await flushPromises();
    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;
    using _startup = { [Symbol.dispose]: dispose };
    await navigation;
    expect(harness.router.currentRoute.value.path).toBe('/chat/other');
    expect(harness.router.currentRoute.value.query['data-zip']).toBe('unprocessed');
  });
});
