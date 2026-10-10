import { useModelLaunchOnboardingBypass } from '@/features/llama-cpp-browser/composables/useModelLaunchOnboardingBypass';
import { isOnboardingExcludedPath } from '@/logic/onboarding-route-policy';
import { resolveInitialRoute } from '@/logic/startup/startup-route';
import { routerKey, START_LOCATION, type Router } from 'vue-router';
import {
  computed,
  inject,
  provide,
  type ComputedRef,
  type InjectionKey,
  type Ref,
  type ShallowRef,
} from 'vue';
import { useSettings } from '@/composables/useSettings';
import type { StartupState } from '@/logic/startup/types';

export type OnboardingPresentation =
  | 'hidden'
  | 'visible';

export type AppInteraction =
  | 'blocked-by-startup'
  | 'blocked-by-onboarding'
  | 'enabled';

type AppPresentation = Readonly<{
  onboardingPresentation: ComputedRef<OnboardingPresentation>,
  appInteraction: ComputedRef<AppInteraction>,
}>;

const appPresentationKey: InjectionKey<AppPresentation> = Symbol('app-presentation');

export function isAppInteractionEnabled({ interaction }: {
  interaction: AppInteraction,
}): boolean {
  switch (interaction) {
  case 'blocked-by-startup':
  case 'blocked-by-onboarding':
    return false;
  case 'enabled':
    return true;
  default: {
    const _ex: never = interaction;
    return _ex;
  }
  }
}

function createAppPresentation({
  startupState,
  settingsInitialized,
  isOnboardingDismissed,
  modelLaunchBypass,
  onboardingRouteExcluded,
}: {
  startupState: ShallowRef<StartupState>,
  settingsInitialized: Readonly<Ref<boolean>>,
  isOnboardingDismissed: Readonly<Ref<boolean>>,
  modelLaunchBypass: Readonly<Ref<boolean>>,
  onboardingRouteExcluded: Readonly<Ref<boolean>>,
}): AppPresentation {
  const onboardingPresentation = computed<OnboardingPresentation>(() => {
    if (!settingsInitialized.value) {
      return 'hidden';
    }

    return isOnboardingDismissed.value || modelLaunchBypass.value || onboardingRouteExcluded.value
      ? 'hidden'
      : 'visible';
  });

  const appInteraction = computed<AppInteraction>(() => {
    const state = startupState.value;
    switch (state.kind) {
    case 'initializing-foundation':
    case 'starting-main':
    case 'rendering-main':
      return 'blocked-by-startup';
    case 'ready':
    case 'foundation-failed':
    case 'main-failed':
      break;
    default: {
      const _ex: never = state;
      return _ex;
    }
    }

    const presentation = onboardingPresentation.value;
    switch (presentation) {
    case 'hidden':
      return 'enabled';
    case 'visible':
      return 'blocked-by-onboarding';
    default: {
      const _ex: never = presentation;
      return _ex;
    }
    }
  });

  return {
    onboardingPresentation,
    appInteraction,
  };
}

function createOnboardingRouteExcluded({ router }: { router: Router | undefined }): ComputedRef<boolean> {
  return computed(() => {
    if (router === undefined) return false;
    // Navigation is gated until the main app renders. START_LOCATION must not
    // briefly expose onboarding when opening an excluded deep link directly.
    const route = router.currentRoute.value === START_LOCATION
      ? resolveInitialRoute({ router })
      : router.currentRoute.value;
    return isOnboardingExcludedPath({ path: route.path });
  });
}

export function provideAppPresentation({ startupState }: {
  startupState: ShallowRef<StartupState>,
}): AppPresentation {
  const settingsStore = useSettings();
  const onboardingRouteExcluded = createOnboardingRouteExcluded({ router: inject(routerKey, undefined) });
  const presentation = createAppPresentation({
    startupState,
    settingsInitialized: settingsStore.initialized,
    isOnboardingDismissed: settingsStore.isOnboardingDismissed,
    modelLaunchBypass: useModelLaunchOnboardingBypass({ initialized: settingsStore.initialized, storageType: computed(() => settingsStore.settings.value.storageType) }),
    onboardingRouteExcluded,
  });
  provide(appPresentationKey, presentation);
  return presentation;
}

export function useAppPresentation(): AppPresentation {
  const presentation = inject(appPresentationKey);
  if (presentation === undefined) {
    throw new Error('App presentation was used outside App.');
  }
  return presentation;
}

export const TEST_ONLY = {
  createAppPresentation,
  createOnboardingRouteExcluded,
};
