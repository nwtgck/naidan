import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_ONLY as appBlockingTestOnly } from '@/composables/useAppBlockingOperation';
import {
  TEST_ONLY as overlayTestOnly,
  useGlobalBlockingOverlay,
} from '@/composables/useGlobalBlockingOverlay';
import {
  TEST_ONLY,
  useOpfsEncryptionTransition,
} from './useOpfsEncryptionTransition';

afterEach(() => {
  TEST_ONLY.reset();
  overlayTestOnly.reset();
  appBlockingTestOnly.activeOperations.clear();
  vi.unstubAllGlobals();
});

describe('useOpfsEncryptionTransition', () => {
  it('keeps the local app blocked after transition settlement until reload', () => {
    const transition = useOpfsEncryptionTransition();

    transition.beginLocalOperation();
    expect(transition.active.value).toBe(true);
    transition.finishLocalOperation({
      outcome: 'settled_for_reload',
    });
    expect(transition.active.value).toBe(true);
  });

  it('unblocks the local app when preparation fails before transition start', () => {
    const transition = useOpfsEncryptionTransition();

    transition.beginLocalOperation();
    transition.finishLocalOperation({
      outcome: 'preparation_failed',
    });

    expect(transition.active.value).toBe(false);
  });

  it('reuses a pending local overlay when another tab wins the transition lock', () => {
    const transition = useOpfsEncryptionTransition();

    transition.beginLocalOperation();
    const globalOverlay = useGlobalBlockingOverlay().overlay;
    const overlayBeforeExternalStart = globalOverlay.value;

    expect(() => transition.beginExternalOperation()).not.toThrow();
    expect(transition.active.value).toBe(true);
    expect(globalOverlay.value).toBe(overlayBeforeExternalStart);

    transition.finishLocalOperation({
      outcome: 'preparation_failed',
    });
    expect(transition.active.value).toBe(true);
    expect(globalOverlay.value).toBe(overlayBeforeExternalStart);
  });

  it('keeps the local app blocked when a failed transition settles for reload', () => {
    const transition = useOpfsEncryptionTransition();

    transition.beginLocalOperation();
    transition.finishLocalOperation({
      outcome: 'settled_for_reload',
    });

    expect(transition.active.value).toBe(true);
  });
});
