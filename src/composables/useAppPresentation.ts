import { resolveInitialRoute } from '@/logic/startup/startup-route';
import { routerKey, START_LOCATION, type Router } from 'vue-router';
import {
  computed,
  inject,
  provide,
  ref,
  watch,
  type ComputedRef,
  type InjectionKey,
  type ShallowRef,
} from 'vue';
import type { StartupState } from '@/logic/startup/types';
import { isHomepageIntroductionRoute, type HomeIntroduction } from '@/logic/document-metadata';

export type AppInteraction =
  | 'blocked-by-startup'
  | 'enabled';

type CoreAppPresentation = Readonly<{
  appInteraction: ComputedRef<AppInteraction>,
}>;
type AppPresentation = CoreAppPresentation & ReturnType<typeof createHomeIntroduction>;

const appPresentationKey: InjectionKey<AppPresentation> = Symbol('app-presentation');

export function isAppInteractionEnabled({ interaction }: {
  interaction: AppInteraction,
}): boolean {
  switch (interaction) {
  case 'blocked-by-startup':
    return false;
  case 'enabled':
    return true;
  default: {
    const _ex: never = interaction;
    return _ex;
  }
  }
}

function createAppPresentation({ startupState }: { startupState: ShallowRef<StartupState> }): CoreAppPresentation {
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
      return 'enabled';
    default: {
      const _ex: never = state;
      return _ex;
    }
    }
  });
  return { appInteraction };
}

function createHomeIntroduction({ router }: { router: Router | undefined }) {
  const initialRoute = router === undefined ? undefined : resolveInitialRoute({ router });
  const state = ref<HomeIntroduction>(initialRoute !== undefined && isHomepageIntroductionRoute({ route: initialRoute })
    ? { kind: 'active', routePaths: [initialRoute.path] } : { kind: 'inactive' });

  function finishHomeIntroduction(): void {
    state.value = { kind: 'inactive' };
  }

  function continueHomeIntroduction({ routePath }: { routePath: string }): void {
    const current = state.value;
    switch (current.kind) {
    case 'inactive': return;
    case 'active':
      state.value = { kind: 'active', routePaths: [...new Set([...current.routePaths, routePath])] };
      return;
    default: {
      const _ex: never = current;
      return _ex;
    }
    }
  }

  if (router !== undefined) {
    watch(() => router.currentRoute.value, route => {
      if (route === START_LOCATION) {
        return;
      }
      const current = state.value;
      switch (current.kind) {
      case 'inactive':
        return;
      case 'active':
        if (!current.routePaths.includes(route.path)
          || route.query['llama-cpp-browser-model'] !== undefined || route.query.q !== undefined || route.query.settings !== undefined) {
          finishHomeIntroduction();
        }
        return;
      default: {
        const _ex: never = current;
        return _ex;
      }
      }
    });
  }

  return { homeIntroduction: computed(() => state.value), continueHomeIntroduction, finishHomeIntroduction };
}

export function provideAppPresentation({ startupState }: {
  startupState: ShallowRef<StartupState>,
}): AppPresentation {
  const router = inject(routerKey, undefined);
  const core = createAppPresentation({ startupState });
  const presentation: AppPresentation = { ...core, ...createHomeIntroduction({ router }) };
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
  createHomeIntroduction,
};
