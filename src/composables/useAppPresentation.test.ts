import { defineComponent, ref, shallowRef } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StartupState } from '@/logic/startup/types';
import type { OpfsEncryptionStartupGate } from '@/logic/startup/opfs-encryption-startup-gate';
import { TEST_ONLY } from './useAppPresentation';

const settingsInitialized = ref(false);
const isOnboardingDismissed = ref(false);
const blockingOperationActive = ref(false);
const MainApp = defineComponent({
  template: '<div />',
});
const opfsEncryptionGate = {
  inspection: shallowRef({
    type: 'recovery_required',
    error: new Error('test'),
  }),
  phase: shallowRef('locked'),
  applicationError: shallowRef(undefined),
  unlockWithPassphrase: async () => {},
  retryInspection: async () => {},
  reportApplicationFailure: () => {},
  reportUnlockPresentationReady: () => {},
  wait: async () => {},
  waitForUnlockPresentation: async () => {},
} as OpfsEncryptionStartupGate;

const startupState = shallowRef<StartupState>({
  kind: 'initializing-foundation',
});

describe('app presentation', () => {
  beforeEach(() => {
    settingsInitialized.value = false;
    isOnboardingDismissed.value = false;
    blockingOperationActive.value = false;
    startupState.value = {
      kind: 'initializing-foundation',
    };
  });

  function createPresentation() {
    return TEST_ONLY.createAppPresentation({
      startupState,
      settingsInitialized,
      isOnboardingDismissed,
      blockingOperationActive,
    });
  }

  it('derives interaction from the startup union and onboarding presentation', () => {
    const {
      onboardingPresentation,
      appInteraction,
    } = createPresentation();

    expect(onboardingPresentation.value).toBe('hidden');
    expect(appInteraction.value).toBe('blocked-by-startup');

    settingsInitialized.value = true;
    expect(onboardingPresentation.value).toBe('visible');
    expect(appInteraction.value).toBe('blocked-by-startup');

    startupState.value = {
      kind: 'ready',
      mainApp: MainApp,
    };
    expect(appInteraction.value).toBe('blocked-by-onboarding');

    isOnboardingDismissed.value = true;
    expect(onboardingPresentation.value).toBe('hidden');
    expect(appInteraction.value).toBe('enabled');
  });


  it('blocks interaction while a generic operation is active', () => {
    const { appInteraction } = createPresentation();

    settingsInitialized.value = true;
    isOnboardingDismissed.value = true;
    startupState.value = {
      kind: 'ready',
      mainApp: MainApp,
    };
    expect(appInteraction.value).toBe('enabled');

    blockingOperationActive.value = true;
    expect(appInteraction.value).toBe('blocked-by-operation');
  });

  it('never interprets an encrypted startup gate as onboarding', () => {
    const {
      onboardingPresentation,
      appInteraction,
    } = createPresentation();

    settingsInitialized.value = true;
    startupState.value = {
      kind: 'opfs-encryption-required',
      gate: opfsEncryptionGate,
    };

    expect(onboardingPresentation.value).toBe('hidden');
    expect(appInteraction.value).toBe('blocked-by-startup');
  });

  it('keeps onboarding outside the encrypted startup presentation until the app is ready', () => {
    const { onboardingPresentation } = createPresentation();

    settingsInitialized.value = true;
    startupState.value = {
      kind: 'starting-main-after-opfs-unlock',
      gate: opfsEncryptionGate,
    };
    expect(onboardingPresentation.value).toBe('hidden');

    startupState.value = {
      kind: 'rendering-main-after-opfs-unlock',
      gate: opfsEncryptionGate,
      mainApp: MainApp,
      renderGate: {
        reportInitialRender: () => {},
        reportInitialRenderFailure: () => {},
        waitForInitialRender: async () => {},
      },
    };
    expect(onboardingPresentation.value).toBe('hidden');

    startupState.value = {
      kind: 'ready',
      mainApp: MainApp,
    };
    expect(onboardingPresentation.value).toBe('visible');
  });

  it('allows an error view to be used when onboarding is hidden', () => {
    const {
      onboardingPresentation,
      appInteraction,
    } = createPresentation();

    settingsInitialized.value = true;
    isOnboardingDismissed.value = true;
    startupState.value = {
      kind: 'main-failed',
      error: new Error('failed'),
    };

    expect(onboardingPresentation.value).toBe('hidden');
    expect(appInteraction.value).toBe('enabled');
  });

  it('keeps an error view behind onboarding blocked while onboarding is visible', () => {
    const { appInteraction } = createPresentation();

    settingsInitialized.value = true;
    isOnboardingDismissed.value = false;
    blockingOperationActive.value = false;
    startupState.value = {
      kind: 'foundation-failed',
      error: new Error('failed'),
    };

    expect(appInteraction.value).toBe('blocked-by-onboarding');
  });
});
