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
import type { StartupState } from '@/models/startup';

export type OnboardingPresentation =
  | 'hidden'
  | 'visible';

export type ApplicationInteraction =
  | 'blocked-by-startup'
  | 'blocked-by-onboarding'
  | 'enabled';

type ApplicationPresentation = Readonly<{
  onboardingPresentation: ComputedRef<OnboardingPresentation>,
  applicationInteraction: ComputedRef<ApplicationInteraction>,
}>;

const applicationPresentationKey: InjectionKey<ApplicationPresentation> = Symbol('application-presentation');

export function isApplicationInteractionEnabled({ interaction }: {
  interaction: ApplicationInteraction,
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

function createApplicationPresentation({
  startupState,
  settingsInitialized,
  isOnboardingDismissed,
}: {
  startupState: ShallowRef<StartupState>,
  settingsInitialized: Readonly<Ref<boolean>>,
  isOnboardingDismissed: Readonly<Ref<boolean>>,
}): ApplicationPresentation {
  const onboardingPresentation = computed<OnboardingPresentation>(() => {
    if (!settingsInitialized.value) {
      return 'hidden';
    }

    return isOnboardingDismissed.value
      ? 'hidden'
      : 'visible';
  });

  const applicationInteraction = computed<ApplicationInteraction>(() => {
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
    applicationInteraction,
  };
}

export function provideApplicationPresentation({ startupState }: {
  startupState: ShallowRef<StartupState>,
}): ApplicationPresentation {
  const settingsStore = useSettings();
  const presentation = createApplicationPresentation({
    startupState,
    settingsInitialized: settingsStore.initialized,
    isOnboardingDismissed: settingsStore.isOnboardingDismissed,
  });
  provide(applicationPresentationKey, presentation);
  return presentation;
}

export function useApplicationPresentation(): ApplicationPresentation {
  const presentation = inject(applicationPresentationKey);
  if (presentation === undefined) {
    throw new Error('Application presentation was used outside StartupRoot.');
  }
  return presentation;
}

export const TEST_ONLY = {
  createApplicationPresentation,
};
