import { defineComponent } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_ONLY as appBlockingTestOnly } from './useAppBlockingOperation';
import {
  showGlobalBlockingOverlay,
  TEST_ONLY,
  useGlobalBlockingOverlay,
} from './useGlobalBlockingOverlay';

const TestOverlay = defineComponent({
  template: '<div />',
});

afterEach(() => {
  TEST_ONLY.reset();
  appBlockingTestOnly.activeOperations.clear();
});

describe('global blocking overlay', () => {
  it('exposes one overlay and clears it with an idempotent close callback', () => {
    const { overlay } = useGlobalBlockingOverlay();
    const close = showGlobalBlockingOverlay({ operation: 'storage_transition', component: TestOverlay });

    expect(overlay.value?.component).toBe(TestOverlay);

    close();
    close();

    expect(overlay.value).toBeUndefined();
  });

  it('rejects nested global blocking overlays', () => {
    const close = showGlobalBlockingOverlay({ operation: 'storage_transition', component: TestOverlay });

    expect(() => showGlobalBlockingOverlay({ operation: 'storage_transition', component: TestOverlay }))
      .toThrow('already active');

    close();
  });
});
