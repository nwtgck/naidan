import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { TEST_ONLY as PERSISTENCE_RUNTIME_TEST_ONLY, type OpfsEncryptionInspection } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import { createOpfsEncryptionStartupGate } from './opfs-encryption-startup-gate';

function createCredentialRequiredInspection(): Extract<OpfsEncryptionInspection, { type: 'credential_required' }> {
  return PERSISTENCE_RUNTIME_TEST_ONLY.createCredentialRequiredInspection({
    firstSequence: 2,
    secondSequence: 1,
  });
}

function createTransitioningInspection(): Extract<OpfsEncryptionInspection, { type: 'transitioning' }> {
  return PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
    operation: 're_encrypt',
    phase: 'building_target',
    sourceFileSystemId: 'source-store',
    targetFileSystemId: 'target-store',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createOpfsEncryptionStartupGate', () => {
  it('unlocks credential-required storage with a passphrase before completing the gate', async () => {
    const unlock = vi.spyOn(storageService, 'unlockOpfsEncryptionWithPassphrase')
      .mockResolvedValue(undefined);
    const gate = createOpfsEncryptionStartupGate({
      inspection: createCredentialRequiredInspection(),
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

  it('converges an interrupted transition without selecting detailed resume progress', async () => {
    const converge = vi.spyOn(storageService, 'convergeOpfsEncryptionTransitionWithPassphrase')
      .mockResolvedValue(undefined);
    const resume = vi.spyOn(storageService, 'resumeOpfsEncryptionTransitionWithPassphrase')
      .mockRejectedValue(new Error('detailed resume must not be selected during startup'));
    const gate = createOpfsEncryptionStartupGate({
      inspection: createTransitioningInspection(),
    });

    await gate.unlockWithPassphrase({ passphrase: 'transition passphrase' });
    await gate.wait();

    expect(converge).toHaveBeenCalledWith({
      passphrase: 'transition passphrase',
      signal: undefined,
    });
    expect(resume).not.toHaveBeenCalled();
    expect(gate.progress.value).toBeUndefined();
    expect(gate.phase.value).toBe('preparing_application');
  });


  it('returns interrupted pre-authority encryption to plain with an authenticated passphrase', async () => {
    const returnToPlain = vi.spyOn(storageService, 'returnInterruptedOpfsEncryptionToPlain')
      .mockResolvedValue(undefined);
    const gate = createOpfsEncryptionStartupGate({
      inspection: PERSISTENCE_RUNTIME_TEST_ONLY.createTransitioningInspection({
        operation: 'encrypt',
        phase: 'building_target',
        sourceFileSystemId: undefined,
        targetFileSystemId: 'target-store',
      }),
    });

    await gate.returnInterruptedEncryptionToPlain({ passphrase: 'existing passphrase' });
    await gate.wait();

    expect(returnToPlain).toHaveBeenCalledWith({
      passphrase: 'existing passphrase',
      signal: undefined,
      onProgress: expect.any(Function),
    });
    expect(gate.phase.value).toBe('preparing_application');
  });

  it('returns to the locked phase when passphrase unlock fails', async () => {
    vi.spyOn(storageService, 'unlockOpfsEncryptionWithPassphrase')
      .mockRejectedValue(new Error('incorrect passphrase'));
    const gate = createOpfsEncryptionStartupGate({
      inspection: createCredentialRequiredInspection(),
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
      inspection: createCredentialRequiredInspection(),
    });
    const error = new Error('main application failed');

    gate.reportApplicationFailure({ error });

    expect(gate.phase.value).toBe('application_failed');
    expect(gate.applicationError.value).toBe(error);
  });
});
