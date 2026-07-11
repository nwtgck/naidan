import { shallowRef, type ShallowRef } from 'vue';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionInspection } from '@/00-storage/service/opfs-encryption/bootstrap';

export type OpfsEncryptionStartupPhase =
  | 'locked'
  | 'unlocking'
  | 'preparing_application'
  | 'application_failed';

export interface OpfsEncryptionStartupGate {
  readonly inspection: ShallowRef<Exclude<OpfsEncryptionInspection, { type: 'plain' }>>,
  readonly phase: ShallowRef<OpfsEncryptionStartupPhase>,
  readonly applicationError: ShallowRef<unknown | undefined>,
  unlockWithPassphrase({ passphrase }: { passphrase: string }): Promise<void>,
  retryInspection(): Promise<void>,
  reportApplicationFailure({ error }: { error: unknown }): void,
  wait(): Promise<void>,
}

export function createOpfsEncryptionStartupGate({
  inspection,
}: {
  inspection: Exclude<OpfsEncryptionInspection, { type: 'plain' }>,
}): OpfsEncryptionStartupGate {
  const currentInspection = shallowRef(inspection);
  const phase = shallowRef<OpfsEncryptionStartupPhase>('locked');
  const applicationError = shallowRef<unknown>();
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
    const currentPhase = phase.value;
    switch (currentPhase) {
    case 'locked':
      break;
    case 'unlocking':
    case 'preparing_application':
    case 'application_failed':
      throw new Error(`OPFS encryption startup gate cannot unlock from phase: ${currentPhase}`);
    default: {
      const _ex: never = currentPhase;
      throw new Error(`Unhandled OPFS encryption startup phase: ${String(_ex)}`);
    }
    }

    phase.value = 'unlocking';
    applicationError.value = undefined;
    try {
      const value = currentInspection.value;
      switch (value.type) {
      case 'encrypted':
        await storageService.unlockOpfsEncryptionWithPassphrase({ passphrase });
        break;
      case 'transitioning':
        await storageService.resumeOpfsEncryptionTransitionWithPassphrase({
          passphrase,
          signal: undefined,
        });
        break;
      case 'recovery_required':
        throw new Error('The OPFS encryption state must be recovered before it can be unlocked');
      default: {
        const _ex: never = value;
        throw new Error(`Unhandled OPFS encryption startup state: ${String(_ex)}`);
      }
      }

      /**
       * WHY: Cryptographic unlock is only the first half of the visible
       * transition. Keep the lock presentation in front while Settings,
       * Sidebar, ChatPane, and the current route mount behind it. The overlay
       * disappears only after the application shell has painted, preventing
       * users from seeing lazy components assemble themselves.
       */
      phase.value = 'preparing_application';
      complete();
    } catch (error) {
      phase.value = 'locked';
      throw error;
    }
  }

  async function retryInspection(): Promise<void> {
    const value = await storageService.inspectOpfsEncryption();
    switch (value.type) {
    case 'plain':
      // The original provider initialization stopped when it encountered the
      // unreadable encryption control state. Repairing raw OPFS to plain does
      // not initialize a backend by itself, so finish that initialization
      // before allowing Settings and onboarding startup to continue.
      await storageService.retryPlainOpfsInitializationAfterEncryptionRecovery();
      phase.value = 'preparing_application';
      complete();
      return;
    case 'encrypted':
    case 'transitioning':
    case 'recovery_required':
      currentInspection.value = value;
      phase.value = 'locked';
      applicationError.value = undefined;
      return;
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled OPFS encryption inspection: ${String(_ex)}`);
    }
    }
  }

  function reportApplicationFailure({ error }: { error: unknown }): void {
    applicationError.value = error;
    phase.value = 'application_failed';
  }

  return {
    inspection: currentInspection,
    phase,
    applicationError,
    unlockWithPassphrase,
    retryInspection,
    reportApplicationFailure,
    wait: async () => await completion.promise,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
