import { afterEach, expect, it } from 'vitest';
import { computed, effectScope, ref } from 'vue';
import { useImageGeneration } from '@/features/image-generation/test-utils/unavailable-image-view';
import { useImageSessionPresentation } from './use-image-session-presentation';
const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});
function setup() {
  const scope = effectScope(); scopes.push(scope);
  return scope.run(() => {
    const busy = ref(false), selected = ref('A');
    const generation = { ...useImageGeneration(), busy: computed(() => busy.value) };
    const state = useImageSessionPresentation({ generation, selectedKey: selected });
    return { generation, selected, busy, state };
  })!;
}
it('keeps progress and failures with their run and freezes them before another draft is restored', () => {
  const h = setup(); h.state.begin({ key: 'A' }); h.busy.value = true;
  h.generation.progress.value = { phase: 'sampling', step: 3, steps: 8 };
  h.generation.failure.value = 'A failure'; h.generation.diagnosticText.value = 'A diagnostics';
  h.selected.value = 'B';
  expect(h.state.view.progress.value).toBeUndefined(); expect(h.state.view.failure.value).toBe('');
  expect(h.state.otherRunning.value).toBe(true); expect(h.state.view.busy.value).toBe(false);
  h.state.finish(); h.busy.value = false;
  h.generation.failure.value = ''; h.generation.diagnosticText.value = 'B restored';
  h.selected.value = 'A';
  expect(h.state.view.failure.value).toBe('A failure'); expect(h.state.view.diagnosticText.value).toBe('A diagnostics');
  expect(h.state.view.progress.value?.step).toBe(3);
});
it('resets scalar state for a new request without borrowing another session failure', () => {
  const h = setup(); h.state.begin({ key: 'A' }); h.generation.failure.value = 'A'; h.state.finish();
  h.selected.value = 'B'; h.state.begin({ key: 'B' });
  expect(h.state.view.failure.value).toBe(''); h.generation.failure.value = 'B'; h.state.finish();
  h.selected.value = 'A'; expect(h.state.view.failure.value).toBe('A');
  h.state.clear(); expect(h.state.view.failure.value).toBe(''); expect(h.state.startedAt.value).toBeUndefined();
});
