import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageChangeEvent } from '@/00-storage/service/synchronizer';

const testState = vi.hoisted(() => ({
  listener: undefined as undefined | (({ event }: { event: StorageChangeEvent }) => void),
}));

vi.mock('@/00-storage/service', () => ({
  storageService: {
    subscribeToChanges: vi.fn(({ listener }) => {
      testState.listener = listener;
      return () => {};
    }),
  },
}));

import { useOpfsEncryptionTransition } from './useOpfsEncryptionTransition';

afterEach(() => {
  useOpfsEncryptionTransition().finishLocalOperation({ success: true });
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

  it('reloads another tab immediately when a transition starts', () => {
    const reload = vi.fn();
    vi.stubGlobal('window', {
      location: { reload },
    });
    const transition = useOpfsEncryptionTransition();
    if (testState.listener === undefined) {
      throw new Error('Expected storage change subscription');
    }

    testState.listener({
      event: {
        type: 'opfs_encryption',
        status: 'transition_started',
        timestamp: expect.any(Number),
      },
    });

    expect(transition.active.value).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});
