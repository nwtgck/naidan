import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_ONLY as appBlockingTestOnly } from '@/composables/useAppBlockingOperation';
import { TEST_ONLY as overlayTestOnly } from '@/composables/useGlobalBlockingOverlay';
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

    transition.finishLocalOperation({ success: true });
    expect(transition.active.value).toBe(false);
    expect(transition.failed.value).toBe(false);
  });

  it('keeps the local app blocked while reloading after a failed operation', () => {
    const reload = vi.fn();
    vi.stubGlobal('window', {
      location: { reload },
    });
    const transition = useOpfsEncryptionTransition();

    transition.beginLocalOperation();
    transition.finishLocalOperation({ success: false });

    expect(transition.active.value).toBe(true);
    expect(transition.failed.value).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});
