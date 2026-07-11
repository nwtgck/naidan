import { shallowRef, type ShallowRef } from 'vue';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionInspection } from '@/00-storage/service/opfs-encryption/bootstrap';

export interface OpfsEncryptionStartupGate {
  readonly inspection: ShallowRef<Exclude<OpfsEncryptionInspection, { type: 'plain' }>>,
  unlockWithPassphrase({ passphrase }: { passphrase: string }): Promise<void>,
  unlockWithRecoveryKey({ recoveryKey }: { recoveryKey: string }): Promise<void>,
  retryInspection(): Promise<void>,
  wait(): Promise<void>,
}

export function createOpfsEncryptionStartupGate({
  inspection,
}: {
  inspection: Exclude<OpfsEncryptionInspection, { type: 'plain' }>,
}): OpfsEncryptionStartupGate {
  const currentInspection = shallowRef(inspection);
  const completion = Promise.withResolvers<void>();
  let completed = false;

  function complete(): void {
    if (completed) {
      return;
    }
    completed = true;
    completion.resolve();
  }

  async function unlockWithPassphrase({
    passphrase,
  }: {
    passphrase: string,
  }): Promise<void> {
    const value = currentInspection.value;
    switch (value.type) {
    case 'encrypted':
      await storageService.unlockOpfsEncryptionWithPassphrase({ passphrase });
      complete();
      return;
    case 'transitioning':
      await storageService.resumeOpfsEncryptionTransitionWithPassphrase({
        passphrase,
        signal: undefined,
      });
      complete();
      return;
    case 'recovery_required':
      throw new Error('The OPFS encryption state must be recovered before it can be unlocked');
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled OPFS encryption startup state: ${String(_ex)}`);
    }
    }
  }

  async function unlockWithRecoveryKey({
    recoveryKey,
  }: {
    recoveryKey: string,
  }): Promise<void> {
    const value = currentInspection.value;
    switch (value.type) {
    case 'encrypted':
      await storageService.unlockOpfsEncryptionWithRecoveryKey({ recoveryKey });
      complete();
      return;
    case 'transitioning':
      await storageService.resumeOpfsEncryptionTransitionWithRecoveryKey({
        recoveryKey,
        signal: undefined,
      });
      complete();
      return;
    case 'recovery_required':
      throw new Error('The OPFS encryption state must be recovered before it can be unlocked');
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled OPFS encryption startup state: ${String(_ex)}`);
    }
    }
  }

  async function retryInspection(): Promise<void> {
    const value = await storageService.inspectOpfsEncryption();
    switch (value.type) {
    case 'plain':
      complete();
      return;
    case 'encrypted':
    case 'transitioning':
    case 'recovery_required':
      currentInspection.value = value;
      return;
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled OPFS encryption inspection: ${String(_ex)}`);
    }
    }
  }

  return {
    inspection: currentInspection,
    unlockWithPassphrase,
    unlockWithRecoveryKey,
    retryInspection,
    wait: async () => await completion.promise,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
