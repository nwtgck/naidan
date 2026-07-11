import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionInspection } from '@/00-storage/service/opfs-encryption/bootstrap';
import { createOpfsEncryptionStartupGate } from './opfs-encryption-startup-gate';

function createEncryptedInspection(): Extract<OpfsEncryptionInspection, { type: 'encrypted' }> {
  return {
    type: 'encrypted',
    state: {
      formatVersion: 1,
      sequence: 1,
      state: 'encrypted',
      passphraseKeySlot: {
        pbkdf2: {
          salt: 'salt',
          iterations: 10,
        },
        wrappedStorageUnlockKey: {
          nonce: 'nonce',
          ciphertext: 'ciphertext',
        },
      },
      activeEncryptedStoreId: 'encrypted-store',
    },
  };
}

function createTransitioningInspection(): Extract<OpfsEncryptionInspection, { type: 'transitioning' }> {
  const operation = {
    type: 'reencrypting' as const,
    phase: 'building_target' as const,
    sourceEncryptedStoreId: 'source-store',
    targetEncryptedStoreId: 'target-store',
  };
  return {
    type: 'transitioning',
    state: {
      formatVersion: 1,
      sequence: 2,
      state: 'transitioning',
      passphraseKeySlot: {
        pbkdf2: {
          salt: 'salt',
          iterations: 10,
        },
        wrappedStorageUnlockKey: {
          nonce: 'nonce',
          ciphertext: 'ciphertext',
        },
      },
      operation,
    },
    operation,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createOpfsEncryptionStartupGate', () => {
  it('unlocks encrypted storage with a passphrase before completing the gate', async () => {
    const unlock = vi.spyOn(storageService, 'unlockOpfsEncryptionWithPassphrase')
      .mockResolvedValue(undefined);
    const gate = createOpfsEncryptionStartupGate({
      inspection: createEncryptedInspection(),
    });

    await gate.unlockWithPassphrase({ passphrase: 'correct horse battery staple' });
    await gate.wait();

    expect(unlock).toHaveBeenCalledWith({
      passphrase: 'correct horse battery staple',
    });
  });

  it('resumes an interrupted transition before completing the gate', async () => {
    const resume = vi.spyOn(storageService, 'resumeOpfsEncryptionTransitionWithPassphrase')
      .mockResolvedValue(undefined);
    const gate = createOpfsEncryptionStartupGate({
      inspection: createTransitioningInspection(),
    });

    await gate.unlockWithPassphrase({ passphrase: 'transition passphrase' });
    await gate.wait();

    expect(resume).toHaveBeenCalledWith({
      passphrase: 'transition passphrase',
      signal: undefined,
    });
  });

  it('keeps a recovery-required state blocked', async () => {
    const gate = createOpfsEncryptionStartupGate({
      inspection: {
        type: 'recovery_required',
        error: new Error('invalid state'),
      },
    });

    await expect(gate.unlockWithPassphrase({ passphrase: 'unused' }))
      .rejects.toThrow('must be recovered');
  });

  it('completes when retrying inspection finds plain storage', async () => {
    vi.spyOn(storageService, 'inspectOpfsEncryption')
      .mockResolvedValue({ type: 'plain' });
    const gate = createOpfsEncryptionStartupGate({
      inspection: {
        type: 'recovery_required',
        error: new Error('stale invalid state'),
      },
    });

    await gate.retryInspection();
    await gate.wait();
  });
});
