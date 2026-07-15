import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import { createUnlockedOpfsEncryptionSession } from '@/00-storage/service/opfs-encryption/bootstrap';
import {
  DEFAULT_PBKDF2_ITERATIONS,
  EncryptionTransitionCoordinator,
} from '@/00-storage/service/opfs-encryption/encryption-transition-coordinator';
import type { EncryptionTransitionResult } from '@/00-storage/service/opfs-encryption/session';
import type {
  IOpfsEncryptionWorker,
  OpfsEncryptionWorkerRequest,
  OpfsEncryptionWorkerResult,
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
    async run({ request }) {
      if (currentAbortController !== undefined) {
        throw new Error('An OPFS encryption transition is already running in this Worker');
      }
      const abortController = new AbortController();
      currentAbortController = abortController;
      try {
        return await runTransition({
          request,
          signal: abortController.signal,
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

async function runTransition({
  request,
  signal,
}: {
  request: OpfsEncryptionWorkerRequest;
  signal: AbortSignal;
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
      result = await coordinator.disableEncryption({ session: inputSession, signal });
      break;
    case 'reencrypt':
      inputStorageUnlockKey = request.storageUnlockKey;
      inputSession = await createUnlockedOpfsEncryptionSession({
        storageRoot: request.storageRoot,
        state: request.state,
        storageUnlockKey: request.storageUnlockKey,
        unlockedKeySlotId: request.unlockedKeySlotId,
      });
      result = await coordinator.reencrypt({ session: inputSession, signal });
      break;
    case 'resume':
      result = await coordinator.resumeWithPassphrase({
        state: request.state,
        passphrase: request.passphrase,
        signal,
      });
      break;
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
  runTransition,
};
