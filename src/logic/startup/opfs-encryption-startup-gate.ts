import { shallowRef, type ShallowRef } from 'vue';
import { storageService } from '@/00-storage/service';
import type { OpfsEncryptionInspection } from '@/00-storage/service/naidan-opfs/persistence-runtime-contract';
import type { OpfsEncryptionTransitionProgress } from '@/00-storage/service/naidan-opfs/transition-progress';

export type OpfsEncryptionStartupPhase =
  | 'locked'
  | 'unlocking'
  | 'preparing_application'
  | 'application_failed';

export interface OpfsEncryptionStartupGate {
  readonly inspection: ShallowRef<Exclude<OpfsEncryptionInspection, { type: 'plain' }>>,
  readonly phase: ShallowRef<OpfsEncryptionStartupPhase>,
  readonly applicationError: ShallowRef<unknown | undefined>,
  readonly progress: ShallowRef<OpfsEncryptionTransitionProgress | undefined>,
  unlockWithPassphrase({ passphrase }: { passphrase: string }): Promise<void>,
  returnInterruptedEncryptionToPlain({ passphrase }: { passphrase: string }): Promise<void>,
  retryInspection(): Promise<void>,
  reportApplicationFailure({ error }: { error: unknown }): void,
  reportUnlockPresentationReady(): void,
  wait(): Promise<void>,
  waitForUnlockPresentation(): Promise<void>,
}

export function createOpfsEncryptionStartupGate({
  inspection,
}: {
  inspection: Exclude<OpfsEncryptionInspection, { type: 'plain' }>,
}): OpfsEncryptionStartupGate {
  const currentInspection = shallowRef(inspection);
  const phase = shallowRef<OpfsEncryptionStartupPhase>('locked');
  const applicationError = shallowRef<unknown>();
  const progress = shallowRef<OpfsEncryptionTransitionProgress>();
  const completion = Promise.withResolvers<void>();
  const unlockPresentationCompletion = Promise.withResolvers<void>();
  let completed = false;
  let unlockPresentationCompleted = false;

  function complete(): void {
    if (completed) {
      return;
    }
    completed = true;
    completion.resolve();
  }

  function reportUnlockPresentationReady(): void {
    if (unlockPresentationCompleted) {
      return;
    }
    unlockPresentationCompleted = true;
    unlockPresentationCompletion.resolve();
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
    progress.value = undefined;
    let transitionStarted = false;
    try {
      const value = currentInspection.value;
      switch (value.type) {
      case 'credential_required':
        switch (value.requiredAction) {
        case 'unlock':
          await storageService.unlockOpfsEncryptionWithPassphrase({ passphrase });
          break;
        case 'converge_transition':
          transitionStarted = true;
          await storageService.convergeOpfsEncryptionTransitionWithPassphrase({
            passphrase,
            signal: undefined,
          });
          break;
        default: value.requiredAction satisfies never;
        }
        break;
      case 'encrypted':
        await storageService.unlockOpfsEncryptionWithPassphrase({ passphrase });
        break;
      case 'transitioning':
        transitionStarted = true;
        await storageService.convergeOpfsEncryptionTransitionWithPassphrase({
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

      if (transitionStarted) {
        // The central settlement guard reloads this page. Do not prepare or
        // reveal an application backend from the transition runtime.
        return;
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
      if (!transitionStarted) {
        phase.value = 'locked';
      }
      throw error;
    }
  }

  async function returnInterruptedEncryptionToPlain({
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
      throw new Error(`OPFS encryption startup gate cannot return to plain from phase: ${currentPhase}`);
    default: {
      const _ex: never = currentPhase;
      throw new Error(`Unhandled OPFS encryption startup phase: ${String(_ex)}`);
    }
    }
    const value = currentInspection.value;
    switch (value.type) {
    case 'transitioning':
      break;
    case 'credential_required':
    case 'encrypted':
    case 'recovery_required':
      throw new Error('Only interrupted OPFS encryption can return to plain storage');
    default: {
      const _ex: never = value;
      throw new Error(`Unhandled OPFS encryption inspection: ${((_ex satisfies never) as { readonly type: string }).type}`);
    }
    }
    switch (value.mode.operation) {
    case 'encrypt':
      break;
    case 'decrypt':
    case 're_encrypt':
      throw new Error('Only interrupted OPFS encryption can return to plain storage');
    default: {
      const _ex: never = value.mode.operation;
      throw new Error(`Unhandled OPFS encryption operation: ${((_ex satisfies never) as { readonly type: string }).type}`);
    }
    }
    phase.value = 'unlocking';
    applicationError.value = undefined;
    progress.value = undefined;
    await storageService.returnInterruptedOpfsEncryptionToPlain({
      passphrase,
      signal: undefined,
      onProgress: ({ progress: nextProgress }) => {
        progress.value = nextProgress;
      },
    });
    // Settlement reloads the page; keep the startup gate closed until then.
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
      reportUnlockPresentationReady();
      complete();
      return;
    case 'credential_required':
    case 'encrypted':
    case 'transitioning':
    case 'recovery_required':
      currentInspection.value = value;
      progress.value = undefined;
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
    progress,
    unlockWithPassphrase,
    returnInterruptedEncryptionToPlain,
    retryInspection,
    reportApplicationFailure,
    reportUnlockPresentationReady,
    wait: async () => await completion.promise,
    waitForUnlockPresentation: async () => await unlockPresentationCompletion.promise,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
