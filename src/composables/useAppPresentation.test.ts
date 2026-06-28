import { defineComponent, ref, shallowRef } from 'vue';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StartupState } from '@/models/startup';
import { TEST_ONLY } from './useAppPresentation';

const settingsInitialized = ref(false);
const isOnboardingDismissed = ref(false);
const MainApp = defineComponent({
  template: '<div />',
});

const startupState = shallowRef<StartupState>({
  kind: 'initializing-foundation',
});

describe('app presentation', () => {
  beforeEach(() => {
    settingsInitialized.value = false;
    isOnboardingDismissed.value = false;
    startupState.value = {
      kind: 'initializing-foundation',
    };
  });

  function createPresentation() {
    return TEST_ONLY.createAppPresentation({
      startupState,
      settingsInitialized,
      isOnboardingDismissed,
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
    startupState.value = {
      kind: 'foundation-failed',
      error: new Error('failed'),
    };

    expect(appInteraction.value).toBe('blocked-by-onboarding');
  });
});
