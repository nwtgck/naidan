import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import { createUnlockedOpfsEncryptionSession } from '@/00-storage/service/opfs-encryption/bootstrap';
import {
  DEFAULT_PBKDF2_ITERATIONS,
  EncryptionTransitionCoordinator,
} from '@/00-storage/service/opfs-encryption/encryption-transition-coordinator';
import type { EncryptionTransitionResult } from '@/00-storage/service/opfs-encryption/session';
import type { OpfsEncryptionTransitionProgressListener } from '@/00-storage/service/opfs-encryption/transition-progress';
import type {
  IOpfsEncryptionWorker,
  OpfsEncryptionWorkerRequest,
  OpfsEncryptionWorkerResult,
  OpfsEncryptionWorkerRemoteProgressCallback,
} from './types';

async function closeTransitionResult({
  result,
}: {
  result: EncryptionTransitionResult;
}): Promise<void> {
  switch (result.type) {
  case 'encrypted':
    try {
      await result.session.fileSystemSession.close();
    } finally {
      result.session.storageUnlockKey.fill(0);
    }
    return;
  case 'plain':
    await result.fileSystemSession.close();
    return;
  default: {
    const _ex: never = result;
    throw new Error(`Unhandled transition Worker result: ${String(_ex)}`);
  }
  }
}

export function createOpfsEncryptionWorker(): IOpfsEncryptionWorker {
  let currentAbortController: AbortController | undefined;

  return {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink exposes the request and proxied progress callback as separate transport arguments.
    async run(request, onProgress) {
      if (currentAbortController !== undefined) {
        throw new Error('An OPFS encryption transition is already running in this Worker');
      }
      const abortController = new AbortController();
      currentAbortController = abortController;
      try {
        return await runTransition({
          request,
          signal: abortController.signal,
          onProgress,
        });
      } finally {
        currentAbortController = undefined;
      }
    },
    async cancel() {
      currentAbortController?.abort(new DOMException(
        'OPFS encryption transition was cancelled',
        'AbortError',
      ));
    },
  };
}


const PROGRESS_NOTIFICATION_MINIMUM_INTERVAL_MS = 120;

function createProgressListener({
  onProgress,
}: {
  onProgress: OpfsEncryptionWorkerRemoteProgressCallback | undefined;
}): OpfsEncryptionTransitionProgressListener | undefined {
  if (onProgress === undefined) {
    return undefined;
  }
  let lastReportedAt = Number.NEGATIVE_INFINITY;
  let lastPhase: Parameters<OpfsEncryptionTransitionProgressListener>[0]['progress']['phase'] | undefined;
  return ({ progress }) => {
    const now = performance.now();
    const phaseChanged = progress.phase !== lastPhase;
    const finalUpdate = progress.percent === 100;
    if (
      !phaseChanged
      && !finalUpdate
      && now - lastReportedAt < PROGRESS_NOTIFICATION_MINIMUM_INTERVAL_MS
    ) {
      return;
    }
    lastReportedAt = now;
    lastPhase = progress.phase;
    // Copy loops update counters in-process, but crossing the Worker boundary
    // for every chunk would materially reduce throughput. Emit at most a few
    // UI updates per second while still forwarding phase changes immediately.
    // A detached or reloading caller must never make the durable transition fail.
    void onProgress({ progress }).catch(() => undefined);
  };
}

async function runTransition({
  request,
  signal,
  onProgress,
}: {
  request: OpfsEncryptionWorkerRequest;
  signal: AbortSignal;
  onProgress: OpfsEncryptionWorkerRemoteProgressCallback | undefined;
}): Promise<OpfsEncryptionWorkerResult> {
  const coordinator = new EncryptionTransitionCoordinator({
    storageRoot: request.storageRoot,
    nativeNamespaceRoot: request.nativeNamespaceRoot,
    hostVolumeDB: new HostVolumeDB(),
    pbkdf2Iterations: DEFAULT_PBKDF2_ITERATIONS,
  });

  let inputSession: Awaited<ReturnType<typeof createUnlockedOpfsEncryptionSession>> | undefined;
  let inputStorageUnlockKey: Uint8Array | undefined;
  let result: EncryptionTransitionResult | undefined;
  try {
    switch (request.operation) {
    case 'enable':
      result = await coordinator.enableEncryption({
        passphrase: request.passphrase,
        signal,
        onProgress: createProgressListener({ onProgress }),
      });
      break;
    case 'disable':
      inputStorageUnlockKey = request.storageUnlockKey;
      inputSession = await createUnlockedOpfsEncryptionSession({
        storageRoot: request.storageRoot,
        state: request.state,
        storageUnlockKey: request.storageUnlockKey,
        unlockedKeySlotId: request.unlockedKeySlotId,
      });
      result = await coordinator.disableEncryption({
        session: inputSession,
        signal,
        onProgress: createProgressListener({ onProgress }),
      });
      break;
    case 'reencrypt':
      inputStorageUnlockKey = request.storageUnlockKey;
      inputSession = await createUnlockedOpfsEncryptionSession({
        storageRoot: request.storageRoot,
        state: request.state,
        storageUnlockKey: request.storageUnlockKey,
        unlockedKeySlotId: request.unlockedKeySlotId,
      });
      result = await coordinator.reencrypt({
        session: inputSession,
        signal,
        onProgress: createProgressListener({ onProgress }),
      });
      break;
    case 'resume':
      result = await coordinator.resumeWithPassphrase({
        state: request.state,
        passphrase: request.passphrase,
        signal,
        onProgress: createProgressListener({ onProgress }),
      });
      break;
    case 'return_to_plain':
      result = await coordinator.returnInterruptedEncryptionToPlain({
        state: request.state,
        passphrase: request.passphrase,
        signal,
        onProgress: createProgressListener({ onProgress }),
      });
      break;
    case 'debug_interrupt_enable': {
      const state = await coordinator.createInterruptedEncryptionForDebug({
        passphrase: request.passphrase,
        signal,
      });
      return { type: 'interrupted', state };
    }
    case 'debug_interrupt_disable':
      inputStorageUnlockKey = request.storageUnlockKey;
      inputSession = await createUnlockedOpfsEncryptionSession({
        storageRoot: request.storageRoot,
        state: request.state,
        storageUnlockKey: request.storageUnlockKey,
        unlockedKeySlotId: request.unlockedKeySlotId,
      });
      return {
        type: 'interrupted',
        state: await coordinator.createInterruptedDecryptionForDebug({
          session: inputSession,
          signal,
        }),
      };
    default: {
      const _ex: never = request;
      throw new Error(`Unhandled transition Worker request: ${String(_ex)}`);
    }
    }

    const response = { type: result.type } as const;
    await closeTransitionResult({ result });
    result = undefined;
    return response;
  } finally {
    if (result !== undefined) {
      await closeTransitionResult({ result });
    }
    await inputSession?.fileSystemSession.close();
    inputStorageUnlockKey?.fill(0);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  closeTransitionResult,
  createProgressListener,
  runTransition,
};
