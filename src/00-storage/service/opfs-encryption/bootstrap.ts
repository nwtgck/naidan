import type { EncryptionStateDto } from '@/00-storage/00-dto/encryption.dto';
import { EncryptedOPFSStorageBackend } from './encrypted-opfs-storage-backend';
import { EncryptedStoreHeaderStore } from './encrypted-store-header-store';
import {
  deriveEncryptedStoreRuntimeKeys,
  unlockStorageUnlockKeyWithPassphrase,
  unlockStorageUnlockKeyWithRecoveryKey,
  unwrapStoreRootKey,
} from './encryption-key-manager';
import { EncryptionStateStore } from './encryption-state-store';
import type { UnlockedOpfsEncryptionSession } from './encryption-transition-coordinator';
import type { EncryptedStoreRuntimeKeys } from './types';

export type OpfsEncryptionInspection =
  | { type: 'plain' }
  | {
      type: 'encrypted',
      state: Extract<EncryptionStateDto, { state: 'encrypted' }>,
    }
  | {
      type: 'transitioning',
      state: Extract<EncryptionStateDto, { state: 'transitioning' }>,
      operation: Extract<EncryptionStateDto, { state: 'transitioning' }>['operation'],
    }
  | { type: 'recovery_required', error: unknown };

export async function inspectOpfsEncryption({
  storageRoot,
}: {
  storageRoot: FileSystemDirectoryHandle,
}): Promise<OpfsEncryptionInspection> {
  const stateStore = new EncryptionStateStore({ storageRoot });
  const inspection = await stateStore.inspect();
  switch (inspection.type) {
  case 'plain':
    return inspection;
  case 'invalid':
    return { type: 'recovery_required', error: inspection.error };
  case 'encrypted': {
    const { state } = inspection;
    switch (state.state) {
    case 'encrypted':
      return { type: 'encrypted', state };
    case 'transitioning':
      return {
        type: 'transitioning',
        state,
        operation: state.operation,
      };
    default: {
      const _ex: never = state;
      throw new Error(`Unhandled encryption state: ${String(_ex)}`);
    }
    }
  }
  default: {
    const _ex: never = inspection;
    throw new Error(`Unhandled encryption inspection: ${String(_ex)}`);
  }
  }
}

async function createUnlockedSession({
  storageRoot,
  state,
  storageUnlockKey,
}: {
  storageRoot: FileSystemDirectoryHandle,
  state: Extract<EncryptionStateDto, { state: 'encrypted' }>,
  storageUnlockKey: Uint8Array,
}): Promise<UnlockedOpfsEncryptionSession> {
  const headerStore = new EncryptedStoreHeaderStore({ storageRoot });
  const header = await headerStore.read({
    encryptedStoreId: state.activeEncryptedStoreId,
  });
  if (header === undefined) {
    throw new Error('Active encrypted store has no valid header');
  }
  if (header.encryptedStoreId !== state.activeEncryptedStoreId) {
    throw new Error('Encrypted store header ID does not match active state');
  }
  const storeRootKey = await unwrapStoreRootKey({
    storageUnlockKey,
    header,
  });
  let keys: EncryptedStoreRuntimeKeys;
  try {
    keys = await deriveEncryptedStoreRuntimeKeys({
      storeRootKey,
      encryptedStoreId: state.activeEncryptedStoreId,
    });
  } finally {
    storeRootKey.fill(0);
  }
  const storeDirectory = await headerStore.getStoreDirectory({
    encryptedStoreId: state.activeEncryptedStoreId,
    create: false,
  });
  const backend = new EncryptedOPFSStorageBackend({ storeDirectory, keys });
  await backend.init();
  return {
    state,
    storageUnlockKey,
    backend,
  };
}

export async function unlockOpfsEncryptionWithPassphrase({
  storageRoot,
  state,
  passphrase,
}: {
  storageRoot: FileSystemDirectoryHandle,
  state: Extract<EncryptionStateDto, { state: 'encrypted' }>,
  passphrase: string,
}): Promise<UnlockedOpfsEncryptionSession> {
  const storageUnlockKey = await unlockStorageUnlockKeyWithPassphrase({
    keySlots: state.keySlots,
    passphrase,
  });
  return await createUnlockedSession({ storageRoot, state, storageUnlockKey });
}

export async function unlockOpfsEncryptionWithRecoveryKey({
  storageRoot,
  state,
  recoveryKey,
}: {
  storageRoot: FileSystemDirectoryHandle,
  state: Extract<EncryptionStateDto, { state: 'encrypted' }>,
  recoveryKey: string,
}): Promise<UnlockedOpfsEncryptionSession> {
  const storageUnlockKey = await unlockStorageUnlockKeyWithRecoveryKey({
    keySlots: state.keySlots,
    recoveryKey,
  });
  return await createUnlockedSession({ storageRoot, state, storageUnlockKey });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
