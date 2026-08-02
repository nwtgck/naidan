import type {
  OpfsEncryptionTransitionProgressListener,
  OpfsEncryptionTransitionProgressOperation,
  OpfsEncryptionTransitionProgressPhase,
} from '@/00-storage/service/naidan-opfs/transition-progress';

export type DeveloperOpfsEncryptionInterruptionOperation = 'disable' | 'enable' | 'reencrypt';
export type DeveloperOpfsEncryptionInterruptionBoundary = 'post_switch' | 'pre_switch';

type OrdinaryTransitionRun = ({ onProgress, signal }: {
  onProgress: OpfsEncryptionTransitionProgressListener;
  signal: AbortSignal;
}) => Promise<void>;

const operationProgress = {
  disable: 'decrypting',
  enable: 'encrypting',
  reencrypt: 'reencrypting',
} as const satisfies Record<
  DeveloperOpfsEncryptionInterruptionOperation,
  OpfsEncryptionTransitionProgressOperation
>;

function interruptionPhase({ boundary, operation }: {
  boundary: DeveloperOpfsEncryptionInterruptionBoundary;
  operation: DeveloperOpfsEncryptionInterruptionOperation;
}): OpfsEncryptionTransitionProgressPhase {
  switch (boundary) {
  case 'pre_switch': return 'verifying';
  case 'post_switch': {
    switch (operation) {
    case 'disable': return 'switching_authority';
    case 'enable':
    case 'reencrypt': return 'cleaning_source';
    default: return operation satisfies never;
    }
  }
  default: return boundary satisfies never;
  }
}

/**
 * Deterministically interrupts the ordinary production transition so small
 * fixtures can exercise post-reload UI and coarse convergence without relying
 * on a large dataset or manual timing.
 *
 * This must not synthesize persisted state or introduce resumable progress.
 */
export async function interruptOrdinaryOpfsEncryptionTransition({ boundary, operation, run }: {
  boundary: DeveloperOpfsEncryptionInterruptionBoundary;
  operation: DeveloperOpfsEncryptionInterruptionOperation;
  run: OrdinaryTransitionRun;
}): Promise<void> {
  const controller = new AbortController();
  const interruptionReason = new DOMException(
    `Developer interruption at ${boundary} for ${operation}`,
    'AbortError',
  );
  const expectedOperation = operationProgress[operation];
  const expectedPhase = interruptionPhase({ boundary, operation });
  let interruptionRequested = false;

  try {
    await run({
      onProgress: ({ progress }) => {
        if (
          interruptionRequested
          || progress.operation !== expectedOperation
          || progress.phase !== expectedPhase
        ) {
          return;
        }
        interruptionRequested = true;
        controller.abort(interruptionReason);
      },
      signal: controller.signal,
    });
  } catch (error: unknown) {
    if (
      interruptionRequested
      && controller.signal.aborted
      && controller.signal.reason === interruptionReason
      && error === interruptionReason
    ) {
      return;
    }
    throw error;
  }

  if (!interruptionRequested) {
    throw new Error(`OPFS transition did not reach the selected ${boundary} boundary`);
  }
  throw new Error(`OPFS transition completed after the selected ${boundary} boundary was interrupted`);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
