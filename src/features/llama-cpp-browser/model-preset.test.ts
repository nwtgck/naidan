import { createMemoryHistory, createRouter } from 'vue-router';
import { describe, expect, it } from 'vitest';
import { effectScope, nextTick, ref, shallowRef } from 'vue';
import { TEST_ONLY, type ModelPreset } from './model-preset';

describe('browser model preset presentation', () => {
  it('isolates preset state between routers', () => {
    const first = createRouter({ history: createMemoryHistory(), routes: [] });
    const second = createRouter({ history: createMemoryHistory(), routes: [] });
    expect(TEST_ONLY.stateForRouter({ router: first })).toBe(TEST_ONLY.stateForRouter({ router: first }));
    expect(TEST_ONLY.stateForRouter({ router: first })).not.toBe(TEST_ONLY.stateForRouter({ router: second }));
  });
  it('waits for settings and consumes each query change once without following later dismissal', async () => {
    const input = ref<string | undefined>('hf.co/owner/repo:Q4_K_M'); const initialized = ref(false);
    const isOnboardingDismissed = ref(true); const scope = effectScope();
    const preset = shallowRef<ModelPreset>(); const state = { preset, previousInput: undefined };
    scope.run(() => TEST_ONLY.coordinateModelPreset({ state, input, initialized, isOnboardingDismissed }));
    expect(preset.value).toBeUndefined();
    isOnboardingDismissed.value = false; initialized.value = true; await nextTick();
    expect(preset.value?.target).toBe('onboarding'); expect(preset.value?.claim()).toBe(true);
    const first = preset.value;
    isOnboardingDismissed.value = true; await nextTick();
    expect(preset.value).toBe(first); expect(preset.value?.claim()).toBe(false);
    input.value = 'hf.co/owner/repo:Q8_0'; await nextTick();
    expect(preset.value?.target).toBe('settings'); expect(preset.value?.claim()).toBe(true);
    input.value = undefined; await nextTick(); expect(preset.value).toBeUndefined();
    input.value = 'hf.co/owner/repo:Q8_0'; await nextTick(); expect(preset.value?.claim()).toBe(true);
    scope.stop();
  });
});
