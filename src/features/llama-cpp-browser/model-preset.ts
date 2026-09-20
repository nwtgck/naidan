import { computed, inject, shallowRef, watch, type InjectionKey, type Ref, type ShallowRef } from 'vue';
import { START_LOCATION, routerKey, type Router } from 'vue-router';
import { useSettings } from '@/composables/useSettings';
import { readFirstQueryValue, resolveInitialRoute } from '@/logic/startup/startup-route';

export type ModelPreset = { input: string, target: 'onboarding' | 'settings', claim: () => boolean };
type ModelPresetState = { preset: ShallowRef<ModelPreset | undefined>, previousInput: string | undefined };
const states = new WeakMap<Router, ModelPresetState>();
const presetKey: InjectionKey<Readonly<ShallowRef<ModelPreset | undefined>>> = Symbol('llama-cpp-browser-model-preset');
function stateForRouter({ router }: { router: Router }): ModelPresetState {
  let state = states.get(router);
  if (!state) {
    state = { preset: shallowRef<ModelPreset>(), previousInput: undefined }; states.set(router, state);
  }
  return state;
}
function coordinateModelPreset({ state, input, initialized, isOnboardingDismissed }: {
  state: ModelPresetState,
  input: Readonly<Ref<string | undefined>>,
  initialized: Readonly<Ref<boolean>>,
  isOnboardingDismissed: Readonly<Ref<boolean>>,
}): void {
  watch([input, initialized], ([value, ready]) => {
    if (!ready || value === state.previousInput) return;
    state.previousInput = value;
    if (!value) {
      state.preset.value = undefined; return;
    }
    let claimed = false;
    // A query change is one presentation request, not a persistent settings override.
    state.preset.value = { input: value, target: isOnboardingDismissed.value ? 'settings' : 'onboarding', claim: () => {
      if (claimed) return false;
      claimed = true; return true;
    } };
  }, { immediate: true });
}
export function useModelPresetCoordinator(): Readonly<ShallowRef<ModelPreset | undefined>> | undefined {
  const provided = inject(presetKey, undefined); if (provided) return provided;
  const router = inject(routerKey, undefined); if (!router) return undefined;
  const state = stateForRouter({ router }); const { initialized, isOnboardingDismissed } = useSettings();
  const input = computed(() => {
    // Onboarding can appear while the initial navigation guard is still waiting.
    const route = router.currentRoute.value === START_LOCATION ? resolveInitialRoute({ router }) : router.currentRoute.value;
    return readFirstQueryValue({ value: route.query['llama-cpp-browser-model'] });
  });
  coordinateModelPreset({ state, input, initialized, isOnboardingDismissed });
  return state.preset;
}
export function useModelPreset(): Readonly<ShallowRef<ModelPreset | undefined>> | undefined {
  const provided = inject(presetKey, undefined); if (provided) return provided;
  const router = inject(routerKey, undefined);
  return router ? stateForRouter({ router }).preset : undefined;
}
export const TEST_ONLY = {
  coordinateModelPreset,
  stateForRouter,
  presetKey,
};
