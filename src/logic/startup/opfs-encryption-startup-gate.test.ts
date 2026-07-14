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
      keySlots: [{
        id: 'slot-id',
        keyDerivation: {
          type: 'pbkdf2_hmac_sha256',
          salt: 'salt',
          iterations: 10,
        },
        wrappedStorageUnlockKey: {
          nonce: 'nonce',
          ciphertext: 'ciphertext',
        },
      }],
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
      keySlots: [{
        id: 'slot-id',
        keyDerivation: {
          type: 'pbkdf2_hmac_sha256',
          salt: 'salt',
          iterations: 10,
        },
        wrappedStorageUnlockKey: {
          nonce: 'nonce',
          ciphertext: 'ciphertext',
        },
      }],
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

    expect(gate.phase.value).toBe('locked');
    await gate.unlockWithPassphrase({ passphrase: 'correct horse battery staple' });
    await gate.wait();

    expect(unlock).toHaveBeenCalledWith({
      passphrase: 'correct horse battery staple',
    });
    expect(gate.phase.value).toBe('preparing_application');

    let presentationReady = false;
    const presentation = gate.waitForUnlockPresentation().then(() => {
      presentationReady = true;
    });
    await Promise.resolve();
    expect(presentationReady).toBe(false);

    gate.reportUnlockPresentationReady();
    await presentation;
    expect(presentationReady).toBe(true);
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
    expect(gate.phase.value).toBe('preparing_application');
  });

  it('returns to the locked phase when passphrase unlock fails', async () => {
    vi.spyOn(storageService, 'unlockOpfsEncryptionWithPassphrase')
      .mockRejectedValue(new Error('incorrect passphrase'));
    const gate = createOpfsEncryptionStartupGate({
      inspection: createEncryptedInspection(),
    });

    await expect(gate.unlockWithPassphrase({ passphrase: 'wrong' }))
      .rejects.toThrow('incorrect passphrase');

    expect(gate.phase.value).toBe('locked');
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

  it('initializes the repaired plain backend before completing the gate', async () => {
    vi.spyOn(storageService, 'inspectOpfsEncryption')
      .mockResolvedValue({ type: 'plain' });
    const retryPlainInitialization = vi.spyOn(
      storageService,
      'retryPlainOpfsInitializationAfterEncryptionRecovery',
    ).mockResolvedValue(undefined);
    const gate = createOpfsEncryptionStartupGate({
      inspection: {
        type: 'recovery_required',
        error: new Error('stale invalid state'),
      },
    });

    await gate.retryInspection();
    await gate.wait();
    await gate.waitForUnlockPresentation();

    expect(retryPlainInitialization).toHaveBeenCalledOnce();
    expect(gate.phase.value).toBe('preparing_application');
  });

  it('keeps the startup gate visible when application preparation fails', () => {
    const gate = createOpfsEncryptionStartupGate({
      inspection: createEncryptedInspection(),
    });
    const error = new Error('main application failed');

    gate.reportApplicationFailure({ error });

    expect(gate.phase.value).toBe('application_failed');
    expect(gate.applicationError.value).toBe(error);
  });
});
