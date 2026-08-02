import { describe, expect, it, vi } from 'vitest';
import {
  interruptOrdinaryOpfsEncryptionTransition,
  type DeveloperOpfsEncryptionInterruptionBoundary,
  type DeveloperOpfsEncryptionInterruptionOperation,
} from './developer-opfs-encryption-transition-interruption';
import type {
  OpfsEncryptionTransitionProgressListener,
  OpfsEncryptionTransitionProgressOperation,
  OpfsEncryptionTransitionProgressPhase,
} from '@/00-storage/service/naidan-opfs/transition-progress';

const progressOperation = {
  disable: 'decrypting',
  enable: 'encrypting',
  reencrypt: 'reencrypting',
} as const satisfies Record<
  DeveloperOpfsEncryptionInterruptionOperation,
  OpfsEncryptionTransitionProgressOperation
>;

function report({ onProgress, operation, phase }: {
  onProgress: OpfsEncryptionTransitionProgressListener;
  operation: DeveloperOpfsEncryptionInterruptionOperation;
  phase: OpfsEncryptionTransitionProgressPhase;
}): void {
  onProgress({ progress: {
    completedBytes: 0,
    completedEntries: 0,
    operation: progressOperation[operation],
    percent: undefined,
    phase,
    totalBytes: undefined,
    totalEntries: undefined,
  } });
}

describe('developer OPFS encryption transition interruption', () => {
  it.each([
    { boundary: 'pre_switch', operation: 'enable', phase: 'verifying' },
    { boundary: 'post_switch', operation: 'enable', phase: 'cleaning_source' },
    { boundary: 'pre_switch', operation: 'disable', phase: 'verifying' },
    { boundary: 'post_switch', operation: 'disable', phase: 'switching_authority' },
    { boundary: 'pre_switch', operation: 'reencrypt', phase: 'verifying' },
    { boundary: 'post_switch', operation: 'reencrypt', phase: 'cleaning_source' },
  ] as const)(
    'accepts only its own $operation $boundary abort',
    async ({ boundary, operation, phase }) => {
      const run = vi.fn(async ({ onProgress, signal }: {
        onProgress: OpfsEncryptionTransitionProgressListener;
        signal: AbortSignal;
      }) => {
        report({ onProgress, operation, phase });
        signal.throwIfAborted();
      });

      await expect(interruptOrdinaryOpfsEncryptionTransition({ boundary, operation, run }))
        .resolves.toBeUndefined();
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it('does not hide an AbortError raised before the selected phase', async () => {
    const unrelatedAbort = new DOMException('unrelated abort', 'AbortError');

    await expect(interruptOrdinaryOpfsEncryptionTransition({
      boundary: 'pre_switch',
      operation: 'enable',
      run: async () => {
        throw unrelatedAbort;
      },
    })).rejects.toBe(unrelatedAbort);
  });

  it('does not hide a different error after requesting its abort', async () => {
    const transitionFailure = new Error('transition settlement failed');

    await expect(interruptOrdinaryOpfsEncryptionTransition({
      boundary: 'post_switch',
      operation: 'disable',
      run: async ({ onProgress }) => {
        report({ onProgress, operation: 'disable', phase: 'switching_authority' });
        throw transitionFailure;
      },
    })).rejects.toBe(transitionFailure);
  });

  it('rejects when the selected phase is not reached', async () => {
    const boundary: DeveloperOpfsEncryptionInterruptionBoundary = 'post_switch';

    await expect(interruptOrdinaryOpfsEncryptionTransition({
      boundary,
      operation: 'reencrypt',
      run: async ({ onProgress }) => {
        report({ onProgress, operation: 'reencrypt', phase: 'verifying' });
      },
    })).rejects.toThrow('did not reach the selected post_switch boundary');
  });
});
