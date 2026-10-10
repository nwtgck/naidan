import { defineComponent, ref, shallowRef } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StartupState } from '@/logic/startup/types';
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
      modelLaunchBypass: ref(false),
      onboardingRouteExcluded: ref(false),
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

describe('model launch presentation without onboarding dismissal', () => {
  it('never overlays onboarding on the embedded launcher and still respects startup blocking', () => {
    const bypass = ref(true);
    const startupState = shallowRef<StartupState>({ kind: 'initializing-foundation' });
    const dismissed = ref(false);
    const presentation = TEST_ONLY.createAppPresentation({ startupState, settingsInitialized: ref(true), isOnboardingDismissed: dismissed, modelLaunchBypass: bypass, onboardingRouteExcluded: ref(false) });
    expect(presentation.onboardingPresentation.value).toBe('hidden');
    expect(presentation.appInteraction.value).toBe('blocked-by-startup');
    startupState.value = { kind: 'ready', mainApp: MainApp };
    expect(presentation.onboardingPresentation.value).toBe('hidden');
    expect(presentation.appInteraction.value).toBe('enabled');
    expect(dismissed.value).toBe(false);
    bypass.value = false;
    expect(presentation.onboardingPresentation.value).toBe('visible');
    expect(presentation.appInteraction.value).toBe('blocked-by-onboarding');
  });
});

describe('onboarding route exclusion', () => {
  it('keeps an excluded route unblocked without dismissing onboarding, and reopens it after navigation', () => {
    const excluded = ref(true);
    const dismissed = ref(false);
    const state = shallowRef<StartupState>({ kind: 'ready', mainApp: MainApp });
    const presentation = TEST_ONLY.createAppPresentation({
      startupState: state,
      settingsInitialized: ref(true),
      isOnboardingDismissed: dismissed,
      modelLaunchBypass: ref(false),
      onboardingRouteExcluded: excluded,
    });

    expect(presentation.onboardingPresentation.value).toBe('hidden');
    expect(presentation.appInteraction.value).toBe('enabled');
    expect(dismissed.value).toBe(false);

    excluded.value = false;
    expect(presentation.onboardingPresentation.value).toBe('visible');
    expect(presentation.appInteraction.value).toBe('blocked-by-onboarding');
    expect(dismissed.value).toBe(false);
  });

  it.each(['/image-generation', '/audio-generation/voices'])('uses the deep link before initial navigation resolves: %s', async path => {
    const history = createMemoryHistory();
    history.replace(path);
    const router = createRouter({
      history,
      routes: [
        { path: '/', component: MainApp },
        { path: '/image-generation', component: MainApp },
        { path: '/audio-generation/voices', component: MainApp },
      ],
    });
    const excluded = TEST_ONLY.createOnboardingRouteExcluded({ router });
    expect(excluded.value).toBe(true);
    await router.push('/');
    expect(excluded.value).toBe(false);
    await router.push(path);
    expect(excluded.value).toBe(true);
  });
});
