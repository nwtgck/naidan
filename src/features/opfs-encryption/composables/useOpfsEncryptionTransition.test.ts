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
  it('blocks and unblocks the local app around a successful operation', () => {
    const transition = useOpfsEncryptionTransition();

    transition.beginLocalOperation();
    expect(transition.active.value).toBe(true);
    expect(transition.failed.value).toBe(false);

    transition.finishLocalOperation({
      outcome: 'completed',
      errorMessage: undefined,
    });
    expect(transition.active.value).toBe(false);
    expect(transition.failed.value).toBe(false);
  });

  it('unblocks the local app after a failed operation rolls back safely', () => {
    const transition = useOpfsEncryptionTransition();

    transition.beginLocalOperation();
    transition.finishLocalOperation({
      outcome: 'rolled_back',
      errorMessage: 'copy failed',
    });

    expect(transition.active.value).toBe(false);
    expect(transition.failed.value).toBe(false);
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
      outcome: 'rolled_back',
      errorMessage: 'the local attempt lost the transition lock',
    });
    expect(transition.active.value).toBe(true);
    expect(globalOverlay.value).toBe(overlayBeforeExternalStart);
  });

  it('keeps the local app blocked when the provider cannot prove a stable backend', () => {
    const transition = useOpfsEncryptionTransition();

    transition.beginLocalOperation();
    transition.finishLocalOperation({
      outcome: 'recovery_required',
      errorMessage: 'storage state is uncertain',
    });

    expect(transition.active.value).toBe(true);
    expect(transition.failed.value).toBe(true);
    expect(transition.failureMessage.value).toBe('storage state is uncertain');
  });
});
