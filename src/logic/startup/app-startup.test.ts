import { flushPromises } from '@vue/test-utils';
import { defineComponent, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { useSettings } from '@/composables/useSettings';
import type { Settings } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
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
type SettingsInitOptions = Parameters<SettingsStore['init']>[0];

function createSettingsStore({ onboardingDismissed }: {
  onboardingDismissed: boolean,
}) {
  const isOnboardingDismissed = ref(onboardingDismissed);
  const init = vi.fn(async (_options: SettingsInitOptions) => {});
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

  it('waits at the OPFS encryption gate, then prepares the app without mounting onboarding behind it', async () => {
    const settings = createSettingsStore({ onboardingDismissed: false });
    const harness = createStartupHarness();
    const unlock = vi.spyOn(storageService, 'unlockOpfsEncryptionWithPassphrase')
      .mockResolvedValue(undefined);
    settings.init.mockImplementationOnce(async ({ onOpfsEncryptionAccessRequired }) => {
      if (onOpfsEncryptionAccessRequired === undefined) {
        throw new Error('Expected OPFS encryption startup callback');
      }
      await onOpfsEncryptionAccessRequired({
        inspection: {
          type: 'encrypted',
          state: {
            formatVersion: 1,
            sequence: 1,
            state: 'encrypted',
            keySlots: [{
              id: 'slot-id',
              keyDerivation: {
                type: 'pbkdf2_hmac_sha256',
                salt: 'salt',
                iterations: 10,
              },
              wrappedStorageUnlockKey: {
                nonce: 'nonce',
                ciphertext: 'ciphertext',
              },
            }],
            activeEncryptedStoreId: 'encrypted-store',
          },
        },
      });
    });

    const startup = startApp({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();

    const state = harness.startupState.value;
    expect(state.kind).toBe('opfs-encryption-required');
    expect(loadChatsForAppStartup).not.toHaveBeenCalled();
    expect(harness.loadRouteComponent).not.toHaveBeenCalled();
    if (state.kind !== 'opfs-encryption-required') {
      throw new Error(`Unexpected startup state: ${state.kind}`);
    }

    await state.gate.unlockWithPassphrase({ passphrase: 'correct horse battery staple' });
    await flushPromises();

    expect(unlock).toHaveBeenCalledWith({
      passphrase: 'correct horse battery staple',
    });
    expect(loadChatsForAppStartup).toHaveBeenCalledOnce();
    expect(state.gate.phase.value).toBe('preparing_application');
    expect(harness.startupState.value).toEqual({
      kind: 'rendering-main-after-opfs-unlock',
      gate: state.gate,
      mainApp: MainApp,
      renderGate: expect.any(Object),
    });

    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    await flushPromises();
    const renderingState = harness.startupState.value;
    expect(renderingState.kind).toBe('rendering-main-after-opfs-unlock');
    if (renderingState.kind !== 'rendering-main-after-opfs-unlock') {
      throw new Error(`Unexpected startup state: ${renderingState.kind}`);
    }

    // MainApp reports only after Sidebar and the initial route component mount.
    // The final paint then reveals the completed shell by removing the lock.
    renderingState.renderGate.reportInitialRender();
    await flushPromises();
    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    const dispose = await startup;
    expect(harness.startupState.value.kind).toBe('ready');
    dispose();
    unlock.mockRestore();
  });

  it('propagates an initial route preparation failure while encrypted startup still owns the lock', async () => {
    const settings = createSettingsStore({ onboardingDismissed: true });
    const harness = createStartupHarness({
      path: '/chat/chat-1',
    });
    const unlock = vi.spyOn(storageService, 'unlockOpfsEncryptionWithPassphrase')
      .mockResolvedValue(undefined);
    settings.init.mockImplementationOnce(async ({ onOpfsEncryptionAccessRequired }) => {
      if (onOpfsEncryptionAccessRequired === undefined) {
        throw new Error('Expected OPFS encryption startup callback');
      }
      await onOpfsEncryptionAccessRequired({
        inspection: {
          type: 'encrypted',
          state: {
            formatVersion: 1,
            sequence: 1,
            state: 'encrypted',
            keySlots: [{
              id: 'slot-id',
              keyDerivation: {
                type: 'pbkdf2_hmac_sha256',
                salt: 'salt',
                iterations: 10,
              },
              wrappedStorageUnlockKey: {
                nonce: 'nonce',
                ciphertext: 'ciphertext',
              },
            }],
            activeEncryptedStoreId: 'encrypted-store',
          },
        },
      });
    });

    const startup = startApp({
      startupState: harness.startupState,
      settingsStore: settings.settingsStore,
      router: harness.router,
      navigationGate: harness.navigationGate,
      window: harness.window,
    });
    await flushPromises();
    const lockedState = harness.startupState.value;
    if (lockedState.kind !== 'opfs-encryption-required') {
      throw new Error(`Unexpected startup state: ${lockedState.kind}`);
    }

    await lockedState.gate.unlockWithPassphrase({ passphrase: 'q' });
    await flushPromises();
    flushPresentationPaint({ callbacks: harness.animationFrameCallbacks });
    await flushPromises();

    const renderingState = harness.startupState.value;
    if (renderingState.kind !== 'rendering-main-after-opfs-unlock') {
      throw new Error(`Unexpected startup state: ${renderingState.kind}`);
    }
    const error = new Error('initial chat failed');
    renderingState.renderGate.reportInitialRenderFailure({ error });

    await expect(startup).rejects.toBe(error);
    expect(harness.startupState.value.kind).toBe('rendering-main-after-opfs-unlock');
    unlock.mockRestore();
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
      onOpfsEncryptionAccessRequired: expect.any(Function),
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
