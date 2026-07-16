import { promiseAllKeyed } from '@/utils/promise';
import type {
  OpfsEncryptionOperationDto,
  OpfsEncryptionOperationPhaseDto,
} from '@/00-storage/00-dto/opfs-encryption.dto';
import { NaidanOpfsStorageBackend } from '@/00-storage/service/naidan-opfs/backend';
import { HostVolumeDB } from '@/00-storage/service/opfs/host-volume-db';
import { OPFS_STORAGE_SESSION_LOCK_KEY } from '@/00-storage/service/opfs/opfs-storage-session-lock';
import {
  createNativeOpfsFileSystemSession,
} from '@/00-storage/service/storage-file-system/native-opfs';
import type {
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import {
  createHizoFS,
  createHizoFSBulkBuilder,
  openHizoFS,
  deriveHizoFSFileSystemIdFromRawRootKey,
} from '@/00-storage/service/hizofs';
import {
  clearNaidanPersistenceNamespace,
  copyNaidanPersistenceNamespace,
  verifyNaidanPersistenceNamespaceCopy,
  type NaidanPersistenceNamespaceProgress,
} from './namespace-transfer';
import {
  createEncryptionMaterial,
  createEncryptionOpaqueId,
  DEFAULT_PBKDF2_ITERATIONS,
  unlockStorageUnlockKeyWithPassphrase,
  unwrapFileSystemRootKey,
  wrapFileSystemRootKey,
} from './encryption-key-manager';
import {
  ENCRYPTED_STORES_DIRECTORY_NAME,
  EncryptionStateStore,
} from './encryption-state-store';
import { EncryptedStoreHeaderStore } from './encrypted-store-header-store';
import {
  isNotFoundError,
  removeDirectoryEntryIfPresent,
} from './opfs-json-file';
import {
  clampOpfsEncryptionTransitionPercent,
  type OpfsEncryptionTransitionProgressListener,
  type OpfsEncryptionTransitionProgressOperation,
} from './transition-progress';
import type {
  EncryptionTransitionResult,
  StableOpfsEncryptionState,
  TransitioningOpfsEncryptionState,
  UnlockedOpfsEncryptionSession,
} from './session';

export type {
  EncryptionTransitionResult,
  UnlockedOpfsEncryptionSession,
} from './session';

type TransitioningStateWithOperation<TOperation extends OpfsEncryptionOperationDto> =
  Omit<TransitioningOpfsEncryptionState, 'operation'> & {
    readonly operation: TOperation;
  };


type EncryptingOperation = Extract<OpfsEncryptionOperationDto, {
  readonly type: 'encrypting';
}>;

type TransitionProgressReporter = {
  readonly listener: OpfsEncryptionTransitionProgressListener | undefined;
  report({ phase, percent }: {
    phase: Parameters<OpfsEncryptionTransitionProgressListener>[0]['progress']['phase'];
    percent: number | undefined;
  }): void;
};

function requireEncryptingOperation({
  operation,
  message,
}: {
  operation: OpfsEncryptionOperationDto;
  message: string;
}): EncryptingOperation {
  switch (operation.type) {
  case 'encrypting':
    return operation;
  case 'decrypting':
  case 'reencrypting':
    throw new Error(message);
  default: {
    const _ex: never = operation;
    throw new Error(`Unhandled OPFS encryption operation: ${((_ex satisfies never) as { readonly type: string }).type}`);
  }
  }
}

function isSourceAuthoritativePhase({
  phase,
}: {
  phase: OpfsEncryptionOperationPhaseDto;
}): boolean {
  switch (phase) {
  case 'building_target':
    return true;
  case 'cleaning_up_source':
    return false;
  default: {
    const _ex: never = phase;
    throw new Error(`Unhandled encryption operation phase: ${String(_ex)}`);
  }
  }
}

function assertSameTransitionState({
  expected,
  actual,
}: {
  expected: TransitioningOpfsEncryptionState;
  actual: TransitioningOpfsEncryptionState;
}): void {
  if (
    expected.sequence !== actual.sequence
    || JSON.stringify(expected.operation) !== JSON.stringify(actual.operation)
    || JSON.stringify(expected.keySlots) !== JSON.stringify(actual.keySlots)
  ) {
    throw new Error('OPFS encryption transition state changed in another tab');
  }
}

export { DEFAULT_PBKDF2_ITERATIONS };


function resolveNamespaceProgressFraction({
  progress,
}: {
  progress: NaidanPersistenceNamespaceProgress;
}): number | undefined {
  if (progress.totalBytes === undefined || progress.totalEntries === undefined) {
    return undefined;
  }
  const byteFraction = progress.totalBytes === 0
    ? 1
    : progress.completedBytes / progress.totalBytes;
  const entryFraction = progress.totalEntries === 0
    ? 1
    : progress.completedEntries / progress.totalEntries;
  return progress.totalBytes === 0
    ? entryFraction
    : (byteFraction * 0.9) + (entryFraction * 0.1);
}

function reportTransitionProgress({
  onProgress,
  operation,
  phase,
  percent,
  completedBytes,
  totalBytes,
  completedEntries,
  totalEntries,
}: {
  onProgress?: OpfsEncryptionTransitionProgressListener;
  operation: OpfsEncryptionTransitionProgressOperation;
  phase: Parameters<OpfsEncryptionTransitionProgressListener>[0]['progress']['phase'];
  percent: number | undefined;
  completedBytes: number;
  totalBytes: number | undefined;
  completedEntries: number;
  totalEntries: number | undefined;
}): void {
  onProgress?.({
    progress: {
      operation,
      phase,
      percent: percent === undefined
        ? undefined
        : clampOpfsEncryptionTransitionPercent({ percent }),
      completedBytes,
      totalBytes,
      completedEntries,
      totalEntries,
    },
  });
}

function createTransitionProgressReporter({
  onProgress,
  operation,
}: {
  onProgress: OpfsEncryptionTransitionProgressListener | undefined;
  operation: OpfsEncryptionTransitionProgressOperation;
}): TransitionProgressReporter {
  let latest = {
    completedBytes: 0,
    totalBytes: undefined as number | undefined,
    completedEntries: 0,
    totalEntries: undefined as number | undefined,
  };
  let listener: OpfsEncryptionTransitionProgressListener | undefined;
  if (onProgress !== undefined) {
    listener = ({ progress }) => {
      latest = {
        completedBytes: progress.completedBytes,
        totalBytes: progress.totalBytes,
        completedEntries: progress.completedEntries,
        totalEntries: progress.totalEntries,
      };
      onProgress({ progress });
    };
  }
  return {
    listener,
    report({
      phase,
      percent,
    }): void {
      reportTransitionProgress({
        onProgress,
        operation,
        phase,
        percent,
        ...latest,
      });
    },
  };
}

export class EncryptionTransitionCoordinator {
  constructor({
    storageRoot,
    nativeNamespaceRoot,
    hostVolumeDB,
    pbkdf2Iterations,
  }: {
    storageRoot: FileSystemDirectoryHandle;
    nativeNamespaceRoot: FileSystemDirectoryHandle;
    hostVolumeDB: HostVolumeDB;
    pbkdf2Iterations: number;
  }) {
    this.storageRoot = storageRoot;
    this.nativeNamespaceRoot = nativeNamespaceRoot;
    this.hostVolumeDB = hostVolumeDB;
    this.pbkdf2Iterations = pbkdf2Iterations;
    this.stateStore = new EncryptionStateStore({ storageRoot });
    this.headerStore = new EncryptedStoreHeaderStore({ storageRoot });
  }

  private readonly storageRoot: FileSystemDirectoryHandle;
  private readonly nativeNamespaceRoot: FileSystemDirectoryHandle;
  private readonly hostVolumeDB: HostVolumeDB;
  private readonly pbkdf2Iterations: number;
  private readonly stateStore: EncryptionStateStore;
  private readonly headerStore: EncryptedStoreHeaderStore;

  async enableEncryption({
    passphrase,
    signal,
    onProgress,
  }: {
    passphrase: string;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<EncryptionTransitionResult> {
    const progressReporter = createTransitionProgressReporter({ onProgress, operation: 'encrypting' });
    progressReporter.report({ phase: 'preparing', percent: 0 });
    return await this.withExclusiveTransitionLock({
      run: async () => {
        const inspection = await this.stateStore.inspect();
        switch (inspection.type) {
        case 'plain':
          break;
        case 'encrypted':
        case 'invalid':
          throw new Error(`OPFS encryption cannot be enabled from state: ${inspection.type}`);
        default: {
          const _ex: never = inspection;
          throw new Error(`Unhandled OPFS encryption inspection: ${String(_ex)}`);
        }
        }

        await this.removeEncryptedStoresExcept({ retainedStoreIds: new Set() });
        const source = await this.createNativeBackendSession();
        const encryptedStoreId = createEncryptionOpaqueId();
        const material = await createEncryptionMaterial({
          passphrase,
          pbkdf2Iterations: this.pbkdf2Iterations,
        });
        let targetFileSystemSession: StorageFileSystemSession | undefined;
        let transitionState: TransitioningOpfsEncryptionState | undefined;
        let succeeded = false;
        try {
          targetFileSystemSession = await this.createEncryptedStore({
            encryptedStoreId,
            storageUnlockKey: material.storageUnlockKey,
            fileSystemRootKey: material.fileSystemRootKey,
            replace: true,
          });
          transitionState = {
            formatVersion: 1,
            sequence: 0,
            state: 'transitioning',
            keySlots: material.keySlots,
            operation: {
              type: 'encrypting',
              phase: 'building_target',
              targetEncryptedStoreId: encryptedStoreId,
            },
          };
          await this.stateStore.writeState({ state: transitionState });
          const targetBackend = await this.copyAndValidateNamespace({
            sourceFileSystemSession: source.fileSystemSession,
            targetFileSystemSession,
            operation: 'encrypting',
            signal,
            onProgress: progressReporter.listener,
          });
          transitionState = await this.updateTransitionPhase({
            state: transitionState,
            phase: 'cleaning_up_source',
          });
          progressReporter.report({ phase: 'cleaning_source', percent: 95 });

          // The target became authoritative when the cleaning phase was
          // persisted. Plain cleanup may now be retried without ever falling
          // back to the source namespace.
          await clearNaidanPersistenceNamespace({
            targetRoot: source.fileSystemSession.root,
          });
          const stableState = await this.writeStableState({
            previousState: transitionState,
            activeEncryptedStoreId: encryptedStoreId,
          });
          progressReporter.report({ phase: 'finalizing', percent: 100 });
          succeeded = true;
          return {
            type: 'encrypted',
            session: {
              state: stableState,
              storageUnlockKey: material.storageUnlockKey,
              unlockedKeySlotId: this.requireFirstKeySlotId({
                state: stableState,
              }),
              fileSystemSession: targetFileSystemSession,
              backend: targetBackend,
            },
          };
        } catch (error) {
          if (
            transitionState === undefined
            || isSourceAuthoritativePhase({ phase: transitionState.operation.phase })
          ) {
            await this.runRollback({
              message: 'Failed to roll back OPFS encryption',
              originalError: error,
              rollback: async () => {
                await targetFileSystemSession?.close();
                targetFileSystemSession = undefined;
                await this.headerStore.removeStore({ encryptedStoreId });
                await this.removeEncryptedStoresDirectory();
                await this.stateStore.removeAll();
              },
            });
          }
          throw error;
        } finally {
          await source.fileSystemSession.close();
          material.fileSystemRootKey.fill(0);
          if (!succeeded) {
            material.storageUnlockKey.fill(0);
            await targetFileSystemSession?.close();
          }
        }
      },
    });
  }

  async disableEncryption({
    session,
    signal,
    onProgress,
  }: {
    session: UnlockedOpfsEncryptionSession;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<EncryptionTransitionResult> {
    const progressReporter = createTransitionProgressReporter({ onProgress, operation: 'decrypting' });
    progressReporter.report({ phase: 'preparing', percent: 0 });
    return await this.withExclusiveTransitionLock({
      run: async () => {
        const latestState = await this.requireLatestStableStateForSession({ session });
        const target = await this.createNativeFileSystemSession();
        let transitionState: TransitioningOpfsEncryptionState = {
          formatVersion: 1,
          sequence: latestState.sequence + 1,
          state: 'transitioning',
          keySlots: latestState.keySlots,
          operation: {
            type: 'decrypting',
            phase: 'building_target',
            sourceEncryptedStoreId: latestState.activeEncryptedStoreId,
          },
        };
        let succeeded = false;
        try {
          await this.stateStore.writeState({ state: transitionState });
          const targetBackend = await this.copyAndValidateNamespace({
            sourceFileSystemSession: session.fileSystemSession,
            targetFileSystemSession: target,
            operation: 'decrypting',
            signal,
            onProgress: progressReporter.listener,
          });
          transitionState = await this.updateTransitionPhase({
            state: transitionState,
            phase: 'cleaning_up_source',
          });
          progressReporter.report({ phase: 'cleaning_source', percent: 95 });
          await this.headerStore.removeStore({
            encryptedStoreId: latestState.activeEncryptedStoreId,
          });
          await this.removeEncryptedStoresDirectory();
          await this.stateStore.removeAll();
          progressReporter.report({ phase: 'finalizing', percent: 100 });
          succeeded = true;
          return {
            type: 'plain',
            fileSystemSession: target,
            backend: targetBackend,
          };
        } catch (error) {
          if (isSourceAuthoritativePhase({ phase: transitionState.operation.phase })) {
            await this.runRollback({
              message: 'Failed to roll back OPFS decryption',
              originalError: error,
              rollback: async () => {
                await clearNaidanPersistenceNamespace({ targetRoot: target.root });
                await this.writeStableState({
                  previousState: transitionState,
                  activeEncryptedStoreId: latestState.activeEncryptedStoreId,
                });
              },
            });
          }
          throw error;
        } finally {
          if (!succeeded) {
            await target.close();
          }
        }
      },
    });
  }

  async reencrypt({
    session,
    signal,
    onProgress,
  }: {
    session: UnlockedOpfsEncryptionSession;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<EncryptionTransitionResult> {
    const progressReporter = createTransitionProgressReporter({ onProgress, operation: 'reencrypting' });
    progressReporter.report({ phase: 'preparing', percent: 0 });
    return await this.withExclusiveTransitionLock({
      run: async () => {
        const latestState = await this.requireLatestStableStateForSession({ session });
        await this.removeEncryptedStoresExcept({
          retainedStoreIds: new Set([latestState.activeEncryptedStoreId]),
        });
        const targetEncryptedStoreId = createEncryptionOpaqueId();
        const targetFileSystemRootKey = crypto.getRandomValues(new Uint8Array(32));
        let targetFileSystemSession: StorageFileSystemSession | undefined;
        let transitionState: TransitioningOpfsEncryptionState | undefined;
        let succeeded = false;
        try {
          targetFileSystemSession = await this.createEncryptedStore({
            encryptedStoreId: targetEncryptedStoreId,
            storageUnlockKey: session.storageUnlockKey,
            fileSystemRootKey: targetFileSystemRootKey,
            replace: true,
          });
          transitionState = {
            formatVersion: 1,
            sequence: latestState.sequence + 1,
            state: 'transitioning',
            keySlots: latestState.keySlots,
            operation: {
              type: 'reencrypting',
              phase: 'building_target',
              sourceEncryptedStoreId: latestState.activeEncryptedStoreId,
              targetEncryptedStoreId,
            },
          };
          await this.stateStore.writeState({ state: transitionState });
          const targetBackend = await this.copyAndValidateNamespace({
            sourceFileSystemSession: session.fileSystemSession,
            targetFileSystemSession,
            operation: 'reencrypting',
            signal,
            onProgress: progressReporter.listener,
          });
          transitionState = await this.updateTransitionPhase({
            state: transitionState,
            phase: 'cleaning_up_source',
          });
          progressReporter.report({ phase: 'cleaning_source', percent: 95 });
          await this.headerStore.removeStore({
            encryptedStoreId: latestState.activeEncryptedStoreId,
          });
          const stableState = await this.writeStableState({
            previousState: transitionState,
            activeEncryptedStoreId: targetEncryptedStoreId,
          });
          progressReporter.report({ phase: 'finalizing', percent: 100 });
          succeeded = true;
          return {
            type: 'encrypted',
            session: {
              state: stableState,
              storageUnlockKey: session.storageUnlockKey,
              unlockedKeySlotId: session.unlockedKeySlotId,
              fileSystemSession: targetFileSystemSession,
              backend: targetBackend,
            },
          };
        } catch (error) {
          if (
            transitionState === undefined
            || isSourceAuthoritativePhase({ phase: transitionState.operation.phase })
          ) {
            await this.runRollback({
              message: 'Failed to roll back OPFS re-encryption',
              originalError: error,
              rollback: async () => {
                await targetFileSystemSession?.close();
                targetFileSystemSession = undefined;
                await this.headerStore.removeStore({
                  encryptedStoreId: targetEncryptedStoreId,
                });
                if (transitionState !== undefined) {
                  await this.writeStableState({
                    previousState: transitionState,
                    activeEncryptedStoreId: latestState.activeEncryptedStoreId,
                  });
                }
              },
            });
          }
          throw error;
        } finally {
          targetFileSystemRootKey.fill(0);
          if (!succeeded) {
            await targetFileSystemSession?.close();
          }
        }
      },
    });
  }

  async resumeWithPassphrase({
    state,
    passphrase,
    signal,
    onProgress,
  }: {
    state: TransitioningOpfsEncryptionState;
    passphrase: string;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<EncryptionTransitionResult> {
    const { storageUnlockKey, keySlotId } = await unlockStorageUnlockKeyWithPassphrase({
      keySlots: state.keySlots,
      passphrase,
    });
    let retainedByEncryptedSession = false;
    try {
      const result = await this.resume({
        expectedState: state,
        storageUnlockKey,
        unlockedKeySlotId: keySlotId,
        signal,
        onProgress,
      });
      retainedByEncryptedSession = result.type === 'encrypted';
      return result;
    } finally {
      if (!retainedByEncryptedSession) {
        storageUnlockKey.fill(0);
      }
    }
  }

  async returnInterruptedEncryptionToPlain({
    state,
    passphrase,
    signal,
    onProgress,
  }: {
    state: TransitioningOpfsEncryptionState;
    passphrase: string | undefined;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<EncryptionTransitionResult> {
    const expectedOperation = requireEncryptingOperation({
      operation: state.operation,
      message: 'Only an interrupted encryption operation can return directly to plain storage',
    });

    switch (expectedOperation.phase) {
    case 'building_target':
      return await this.withExclusiveTransitionLock({
        run: async () => {
          const latest = await this.requireLatestTransitioningState({ expectedState: state });
          const latestOperation = requireEncryptingOperation({
            operation: latest.operation,
            message: 'OPFS encryption transition changed before it could be cancelled',
          });
          reportTransitionProgress({
            onProgress,
            operation: 'decrypting',
            phase: 'cleaning_source',
            percent: 70,
            completedBytes: 0,
            totalBytes: undefined,
            completedEntries: 0,
            totalEntries: undefined,
          });
          await this.headerStore.removeStore({
            encryptedStoreId: latestOperation.targetEncryptedStoreId,
          });
          await this.removeEncryptedStoresDirectory();
          await this.stateStore.removeAll();
          const plain = await this.createNativeBackendSession();
          reportTransitionProgress({
            onProgress,
            operation: 'decrypting',
            phase: 'finalizing',
            percent: 100,
            completedBytes: 0,
            totalBytes: 0,
            completedEntries: 0,
            totalEntries: 0,
          });
          return {
            type: 'plain',
            fileSystemSession: plain.fileSystemSession,
            backend: plain.backend,
          };
        },
      });
    case 'cleaning_up_source': {
      if (passphrase === undefined) {
        throw new Error('A passphrase is required because encrypted storage is already authoritative');
      }
      const { storageUnlockKey } = await unlockStorageUnlockKeyWithPassphrase({
        keySlots: state.keySlots,
        passphrase,
      });
      try {
        return await this.withExclusiveTransitionLock({
          run: async () => {
            const latest = await this.requireLatestTransitioningState({ expectedState: state });
            const latestOperation = requireEncryptingOperation({
              operation: latest.operation,
              message: 'OPFS encryption transition changed before it could return to plain storage',
            });
            const decryptingOperation = {
              type: 'decrypting',
              phase: 'building_target',
              sourceEncryptedStoreId: latestOperation.targetEncryptedStoreId,
            } as const;
            const decryptingState: TransitioningOpfsEncryptionState & {
              readonly operation: typeof decryptingOperation;
            } = {
              formatVersion: 1,
              sequence: latest.sequence + 1,
              state: 'transitioning',
              keySlots: latest.keySlots,
              operation: decryptingOperation,
            };
            await this.stateStore.writeState({ state: decryptingState });
            return await this.resumeDecrypting({
              state: {
                ...decryptingState,
                operation: decryptingState.operation,
              },
              storageUnlockKey,
              signal,
              onProgress,
            });
          },
        });
      } finally {
        storageUnlockKey.fill(0);
      }
    }
    default: {
      const _ex: never = expectedOperation.phase;
      throw new Error(`Unhandled interrupted encryption phase: ${String(_ex)}`);
    }
    }
  }

  async createInterruptedEncryptionForDebug({
    passphrase,
    signal,
  }: {
    passphrase: string;
    signal: AbortSignal | undefined;
  }): Promise<TransitioningOpfsEncryptionState> {
    return await this.withExclusiveTransitionLock({
      run: async () => {
        signal?.throwIfAborted();
        const inspection = await this.stateStore.inspect();
        switch (inspection.type) {
        case 'plain':
          break;
        case 'encrypted':
        case 'invalid':
          throw new Error(`Interrupted encryption can only be created from plain storage: ${inspection.type}`);
        default: {
          const _ex: never = inspection;
          throw new Error(`Unhandled OPFS encryption inspection: ${((_ex satisfies never) as { readonly type: string }).type}`);
        }
        }
        await this.removeEncryptedStoresExcept({ retainedStoreIds: new Set() });
        const encryptedStoreId = createEncryptionOpaqueId();
        const material = await createEncryptionMaterial({
          passphrase,
          pbkdf2Iterations: this.pbkdf2Iterations,
        });
        let target: StorageFileSystemSession | undefined;
        try {
          target = await this.createEncryptedStore({
            encryptedStoreId,
            storageUnlockKey: material.storageUnlockKey,
            fileSystemRootKey: material.fileSystemRootKey,
            replace: true,
          });
          await target.close();
          target = undefined;
          const interruptedState: TransitioningOpfsEncryptionState = {
            formatVersion: 1,
            sequence: 0,
            state: 'transitioning',
            keySlots: material.keySlots,
            operation: {
              type: 'encrypting',
              phase: 'building_target',
              targetEncryptedStoreId: encryptedStoreId,
            },
          };
          await this.stateStore.writeState({ state: interruptedState });
          return interruptedState;
        } catch (error) {
          await target?.close();
          await this.headerStore.removeStore({ encryptedStoreId });
          await this.removeEncryptedStoresDirectory();
          throw error;
        } finally {
          material.storageUnlockKey.fill(0);
          material.fileSystemRootKey.fill(0);
        }
      },
    });
  }

  async createInterruptedDecryptionForDebug({
    session,
    signal,
  }: {
    session: UnlockedOpfsEncryptionSession;
    signal: AbortSignal | undefined;
  }): Promise<TransitioningOpfsEncryptionState> {
    return await this.withExclusiveTransitionLock({
      run: async () => {
        signal?.throwIfAborted();
        const latest = await this.requireLatestStableStateForSession({ session });
        const interruptedState: TransitioningOpfsEncryptionState = {
          formatVersion: 1,
          sequence: latest.sequence + 1,
          state: 'transitioning',
          keySlots: latest.keySlots,
          operation: {
            type: 'decrypting',
            phase: 'building_target',
            sourceEncryptedStoreId: latest.activeEncryptedStoreId,
          },
        };
        await this.stateStore.writeState({ state: interruptedState });
        return interruptedState;
      },
    });
  }

  private async resume({
    expectedState,
    storageUnlockKey,
    unlockedKeySlotId,
    signal,
    onProgress,
  }: {
    expectedState: TransitioningOpfsEncryptionState;
    storageUnlockKey: Uint8Array;
    unlockedKeySlotId: string;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<EncryptionTransitionResult> {
    return await this.withExclusiveTransitionLock({
      run: async () => {
        const state = await this.requireLatestTransitioningState({ expectedState });
        const operation = state.operation;
        switch (operation.type) {
        case 'encrypting':
          return await this.resumeEncrypting({
            state: { ...state, operation },
            storageUnlockKey,
            unlockedKeySlotId,
            signal,
            onProgress,
          });
        case 'decrypting':
          return await this.resumeDecrypting({
            state: { ...state, operation },
            storageUnlockKey,
            signal,
            onProgress,
          });
        case 'reencrypting':
          return await this.resumeReencrypting({
            state: { ...state, operation },
            storageUnlockKey,
            unlockedKeySlotId,
            signal,
            onProgress,
          });
        default: {
          const _ex: never = operation;
          throw new Error(`Unhandled OPFS encryption transition: ${String(_ex)}`);
        }
        }
      },
    });
  }

  private async resumeEncrypting({
    state,
    storageUnlockKey,
    unlockedKeySlotId,
    signal,
    onProgress,
  }: {
    state: TransitioningOpfsEncryptionState & {
      readonly operation: Extract<TransitioningOpfsEncryptionState['operation'], {
        readonly type: 'encrypting';
      }>;
    };
    storageUnlockKey: Uint8Array;
    unlockedKeySlotId: string;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<EncryptionTransitionResult> {
    const progressReporter = createTransitionProgressReporter({ onProgress, operation: 'encrypting' });
    progressReporter.report({ phase: 'preparing', percent: 0 });
    const source = await this.createNativeBackendSession();
    let targetFileSystemSession: StorageFileSystemSession | undefined;
    let currentState = state;
    let succeeded = false;
    try {
      switch (currentState.operation.phase) {
      case 'building_target': {
        const fileSystemRootKey = crypto.getRandomValues(new Uint8Array(32));
        try {
          targetFileSystemSession = await this.createEncryptedStore({
            encryptedStoreId: currentState.operation.targetEncryptedStoreId,
            storageUnlockKey,
            fileSystemRootKey,
            replace: true,
          });
        } finally {
          fileSystemRootKey.fill(0);
        }
        await this.copyAndValidateNamespace({
          sourceFileSystemSession: source.fileSystemSession,
          targetFileSystemSession,
          operation: 'encrypting',
          signal,
          onProgress: progressReporter.listener,
        });
        currentState = await this.updateTransitionPhase({
          state: currentState,
          phase: 'cleaning_up_source',
        });
        break;
      }
      case 'cleaning_up_source':
        targetFileSystemSession = await this.openEncryptedStore({
          encryptedStoreId: currentState.operation.targetEncryptedStoreId,
          storageUnlockKey,
        });
        break;
      default: {
        const _ex: never = currentState.operation.phase;
        throw new Error(`Unhandled encryption phase: ${String(_ex)}`);
      }
      }

      const targetBackend = await this.createValidatedBackend({
        fileSystemSession: targetFileSystemSession,
      });
      progressReporter.report({ phase: 'cleaning_source', percent: 95 });
      await clearNaidanPersistenceNamespace({
        targetRoot: source.fileSystemSession.root,
      });
      const stableState = await this.writeStableState({
        previousState: currentState,
        activeEncryptedStoreId: currentState.operation.targetEncryptedStoreId,
      });
      progressReporter.report({ phase: 'finalizing', percent: 100 });
      succeeded = true;
      return {
        type: 'encrypted',
        session: {
          state: stableState,
          storageUnlockKey,
          unlockedKeySlotId,
          fileSystemSession: targetFileSystemSession,
          backend: targetBackend,
        },
      };
    } catch (error) {
      if (isSourceAuthoritativePhase({ phase: currentState.operation.phase })) {
        await this.runRollback({
          message: 'Failed to roll back resumed OPFS encryption',
          originalError: error,
          rollback: async () => {
            await targetFileSystemSession?.close();
            targetFileSystemSession = undefined;
            await this.headerStore.removeStore({
              encryptedStoreId: currentState.operation.targetEncryptedStoreId,
            });
            await this.stateStore.removeAll();
          },
        });
      }
      throw error;
    } finally {
      await source.fileSystemSession.close();
      if (!succeeded) {
        await targetFileSystemSession?.close();
      }
    }
  }

  private async resumeDecrypting({
    state,
    storageUnlockKey,
    signal,
    onProgress,
  }: {
    state: TransitioningOpfsEncryptionState & {
      readonly operation: Extract<TransitioningOpfsEncryptionState['operation'], {
        readonly type: 'decrypting';
      }>;
    };
    storageUnlockKey: Uint8Array;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<EncryptionTransitionResult> {
    const progressReporter = createTransitionProgressReporter({ onProgress, operation: 'decrypting' });
    progressReporter.report({ phase: 'preparing', percent: 0 });
    const target = await this.createNativeFileSystemSession();
    let source: {
      readonly fileSystemSession: StorageFileSystemSession;
      readonly backend: NaidanOpfsStorageBackend;
    } | undefined;
    let currentState = state;
    let succeeded = false;
    try {
      switch (currentState.operation.phase) {
      case 'building_target':
        source = await this.openEncryptedBackendSession({
          encryptedStoreId: currentState.operation.sourceEncryptedStoreId,
          storageUnlockKey,
        });
        await clearNaidanPersistenceNamespace({ targetRoot: target.root });
        await this.copyAndValidateNamespace({
          sourceFileSystemSession: source.fileSystemSession,
          targetFileSystemSession: target,
          operation: 'decrypting',
          signal,
          onProgress: progressReporter.listener,
        });
        currentState = await this.updateTransitionPhase({
          state: currentState,
          phase: 'cleaning_up_source',
        });
        break;
      case 'cleaning_up_source':
        break;
      default: {
        const _ex: never = currentState.operation.phase;
        throw new Error(`Unhandled decryption phase: ${String(_ex)}`);
      }
      }

      const targetBackend = await this.createValidatedBackend({ fileSystemSession: target });
      progressReporter.report({ phase: 'cleaning_source', percent: 95 });
      await this.headerStore.removeStore({
        encryptedStoreId: currentState.operation.sourceEncryptedStoreId,
      });
      await this.removeEncryptedStoresDirectory();
      await this.stateStore.removeAll();
      progressReporter.report({ phase: 'finalizing', percent: 100 });
      succeeded = true;
      return {
        type: 'plain',
        fileSystemSession: target,
        backend: targetBackend,
      };
    } catch (error) {
      if (isSourceAuthoritativePhase({ phase: currentState.operation.phase })) {
        await this.runRollback({
          message: 'Failed to roll back resumed OPFS decryption',
          originalError: error,
          rollback: async () => {
            await clearNaidanPersistenceNamespace({ targetRoot: target.root });
            await this.writeStableState({
              previousState: currentState,
              activeEncryptedStoreId: currentState.operation.sourceEncryptedStoreId,
            });
          },
        });
      }
      throw error;
    } finally {
      await source?.fileSystemSession.close();
      if (!succeeded) {
        await target.close();
      }
    }
  }

  private async resumeReencrypting({
    state,
    storageUnlockKey,
    unlockedKeySlotId,
    signal,
    onProgress,
  }: {
    state: TransitioningOpfsEncryptionState & {
      readonly operation: Extract<TransitioningOpfsEncryptionState['operation'], {
        readonly type: 'reencrypting';
      }>;
    };
    storageUnlockKey: Uint8Array;
    unlockedKeySlotId: string;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<EncryptionTransitionResult> {
    const progressReporter = createTransitionProgressReporter({ onProgress, operation: 'reencrypting' });
    progressReporter.report({ phase: 'preparing', percent: 0 });
    let source: {
      readonly fileSystemSession: StorageFileSystemSession;
      readonly backend: NaidanOpfsStorageBackend;
    } | undefined;
    let targetFileSystemSession: StorageFileSystemSession | undefined;
    let currentState = state;
    let succeeded = false;
    try {
      switch (currentState.operation.phase) {
      case 'building_target': {
        source = await this.openEncryptedBackendSession({
          encryptedStoreId: currentState.operation.sourceEncryptedStoreId,
          storageUnlockKey,
        });
        const fileSystemRootKey = crypto.getRandomValues(new Uint8Array(32));
        try {
          targetFileSystemSession = await this.createEncryptedStore({
            encryptedStoreId: currentState.operation.targetEncryptedStoreId,
            storageUnlockKey,
            fileSystemRootKey,
            replace: true,
          });
        } finally {
          fileSystemRootKey.fill(0);
        }
        await this.copyAndValidateNamespace({
          sourceFileSystemSession: source.fileSystemSession,
          targetFileSystemSession,
          operation: 'reencrypting',
          signal,
          onProgress: progressReporter.listener,
        });
        currentState = await this.updateTransitionPhase({
          state: currentState,
          phase: 'cleaning_up_source',
        });
        break;
      }
      case 'cleaning_up_source':
        targetFileSystemSession = await this.openEncryptedStore({
          encryptedStoreId: currentState.operation.targetEncryptedStoreId,
          storageUnlockKey,
        });
        break;
      default: {
        const _ex: never = currentState.operation.phase;
        throw new Error(`Unhandled re-encryption phase: ${String(_ex)}`);
      }
      }

      const targetBackend = await this.createValidatedBackend({
        fileSystemSession: targetFileSystemSession,
      });
      progressReporter.report({ phase: 'cleaning_source', percent: 95 });
      await this.headerStore.removeStore({
        encryptedStoreId: currentState.operation.sourceEncryptedStoreId,
      });
      const stableState = await this.writeStableState({
        previousState: currentState,
        activeEncryptedStoreId: currentState.operation.targetEncryptedStoreId,
      });
      progressReporter.report({ phase: 'finalizing', percent: 100 });
      succeeded = true;
      return {
        type: 'encrypted',
        session: {
          state: stableState,
          storageUnlockKey,
          unlockedKeySlotId,
          fileSystemSession: targetFileSystemSession,
          backend: targetBackend,
        },
      };
    } catch (error) {
      if (isSourceAuthoritativePhase({ phase: currentState.operation.phase })) {
        await this.runRollback({
          message: 'Failed to roll back resumed OPFS re-encryption',
          originalError: error,
          rollback: async () => {
            await targetFileSystemSession?.close();
            targetFileSystemSession = undefined;
            await this.headerStore.removeStore({
              encryptedStoreId: currentState.operation.targetEncryptedStoreId,
            });
            await this.writeStableState({
              previousState: currentState,
              activeEncryptedStoreId: currentState.operation.sourceEncryptedStoreId,
            });
          },
        });
      }
      throw error;
    } finally {
      await source?.fileSystemSession.close();
      if (!succeeded) {
        await targetFileSystemSession?.close();
      }
    }
  }

  private async createNativeFileSystemSession(): Promise<StorageFileSystemSession> {
    return createNativeOpfsFileSystemSession({
      root: this.nativeNamespaceRoot,
    });
  }

  private async createNativeBackendSession(): Promise<{
    readonly fileSystemSession: StorageFileSystemSession;
    readonly backend: NaidanOpfsStorageBackend;
  }> {
    const fileSystemSession = await this.createNativeFileSystemSession();
    try {
      return {
        fileSystemSession,
        backend: await this.createValidatedBackend({ fileSystemSession }),
      };
    } catch (error) {
      await fileSystemSession.close();
      throw error;
    }
  }

  private async createEncryptedStore({
    encryptedStoreId,
    storageUnlockKey,
    fileSystemRootKey,
    replace,
  }: {
    encryptedStoreId: string;
    storageUnlockKey: Uint8Array;
    fileSystemRootKey: Uint8Array;
    replace: boolean;
  }): Promise<StorageFileSystemSession> {
    if (replace) {
      await this.headerStore.removeStore({ encryptedStoreId });
    }
    const backingDirectory = await this.headerStore.getHizoFSBackingDirectory({
      encryptedStoreId,
      create: true,
    });
    let fileSystemSession: StorageFileSystemSession | undefined;
    try {
      fileSystemSession = await createHizoFS({
        backingDirectory,
        fileSystemRootKey,
      });
      const fileSystemId = await deriveHizoFSFileSystemIdFromRawRootKey({
        fileSystemRootKey,
      });
      await this.headerStore.write({
        header: {
          formatVersion: 1,
          encryptedStoreId,
          fileSystemId,
          wrappedFileSystemRootKey: await wrapFileSystemRootKey({
            storageUnlockKey,
            fileSystemRootKey,
            encryptedStoreId,
          }),
        },
      });
      return fileSystemSession;
    } catch (error) {
      await fileSystemSession?.close();
      await this.headerStore.removeStore({ encryptedStoreId });
      throw error;
    }
  }

  private async openEncryptedStore({
    encryptedStoreId,
    storageUnlockKey,
  }: {
    encryptedStoreId: string;
    storageUnlockKey: Uint8Array;
  }): Promise<StorageFileSystemSession> {
    const header = await this.headerStore.read({ encryptedStoreId });
    if (header === undefined || header.encryptedStoreId !== encryptedStoreId) {
      throw new Error(`Encrypted store header is missing: ${encryptedStoreId}`);
    }
    const fileSystemRootKey = await unwrapFileSystemRootKey({
      storageUnlockKey,
      header,
    });
    try {
      const backingDirectory = await this.headerStore.getHizoFSBackingDirectory({
        encryptedStoreId,
        create: false,
      });
      const fileSystemId = await deriveHizoFSFileSystemIdFromRawRootKey({
        fileSystemRootKey,
      });
      if (fileSystemId !== header.fileSystemId) {
        throw new Error('Encrypted store header file system ID does not match the HizoFS root key');
      }
      return await openHizoFS({ backingDirectory, fileSystemRootKey });
    } finally {
      fileSystemRootKey.fill(0);
    }
  }

  private async openEncryptedBackendSession({
    encryptedStoreId,
    storageUnlockKey,
  }: {
    encryptedStoreId: string;
    storageUnlockKey: Uint8Array;
  }): Promise<{
    readonly fileSystemSession: StorageFileSystemSession;
    readonly backend: NaidanOpfsStorageBackend;
  }> {
    const fileSystemSession = await this.openEncryptedStore({
      encryptedStoreId,
      storageUnlockKey,
    });
    try {
      return {
        fileSystemSession,
        backend: await this.createValidatedBackend({ fileSystemSession }),
      };
    } catch (error) {
      await fileSystemSession.close();
      throw error;
    }
  }

  private async copyAndValidateNamespace({
    sourceFileSystemSession,
    targetFileSystemSession,
    operation,
    signal,
    onProgress,
  }: {
    sourceFileSystemSession: StorageFileSystemSession;
    targetFileSystemSession: StorageFileSystemSession;
    operation: OpfsEncryptionTransitionProgressOperation;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<NaidanOpfsStorageBackend> {
    const sourceSnapshot = await sourceFileSystemSession.createReadSnapshot?.()
      ?? sourceFileSystemSession;
    try {
      reportTransitionProgress({
        onProgress,
        operation,
        phase: 'copying',
        percent: undefined,
        completedBytes: 0,
        totalBytes: undefined,
        completedEntries: 0,
        totalEntries: undefined,
      });
      const totals = await copyNaidanPersistenceNamespace({
        sourceRoot: sourceSnapshot.root,
        targetRoot: targetFileSystemSession.root,
        targetBuilder: await createHizoFSBulkBuilder({
          fileSystemSession: targetFileSystemSession,
        }),
        signal,
        onProgress: ({ progress }) => {
          reportTransitionProgress({
            onProgress,
            operation,
            phase: 'copying',
            percent: undefined,
            completedBytes: progress.completedBytes,
            totalBytes: undefined,
            completedEntries: progress.completedEntries,
            totalEntries: undefined,
          });
        },
      });
      reportTransitionProgress({
        onProgress,
        operation,
        phase: 'copying',
        percent: 55,
        completedBytes: totals.totalBytes,
        totalBytes: totals.totalBytes,
        completedEntries: totals.totalEntries,
        totalEntries: totals.totalEntries,
      });
      const reportVerificationProgress = ({
        progress,
      }: {
        progress: NaidanPersistenceNamespaceProgress;
      }): void => {
        const fraction = resolveNamespaceProgressFraction({ progress });
        reportTransitionProgress({
          onProgress,
          operation,
          phase: 'verifying',
          percent: fraction === undefined ? undefined : 55 + (35 * fraction),
          completedBytes: progress.completedBytes,
          totalBytes: progress.totalBytes,
          completedEntries: progress.completedEntries,
          totalEntries: progress.totalEntries,
        });
      };
      const targetSnapshot = await targetFileSystemSession.createReadSnapshot?.()
        ?? targetFileSystemSession;
      try {
        await verifyNaidanPersistenceNamespaceCopy({
          sourceRoot: sourceSnapshot.root,
          targetRoot: targetSnapshot.root,
          signal,
          totals,
          onProgress: reportVerificationProgress,
        });
      } finally {
        if (targetSnapshot !== targetFileSystemSession) {
          await targetSnapshot.close();
        }
      }
      reportTransitionProgress({
        onProgress,
        operation,
        phase: 'switching_authority',
        percent: 91,
        completedBytes: totals.totalBytes,
        totalBytes: totals.totalBytes,
        completedEntries: totals.totalEntries,
        totalEntries: totals.totalEntries,
      });
      return await this.createValidatedBackend({
        fileSystemSession: targetFileSystemSession,
      });
    } finally {
      if (sourceSnapshot !== sourceFileSystemSession) {
        await sourceSnapshot.close();
      }
    }
  }

  private async createValidatedBackend({
    fileSystemSession,
  }: {
    fileSystemSession: StorageFileSystemSession;
  }): Promise<NaidanOpfsStorageBackend> {
    const backend = new NaidanOpfsStorageBackend({
      namespaceRoot: fileSystemSession.root,
      hostVolumeDB: this.hostVolumeDB,
    });
    await backend.init();

    // Parse all top-level persisted indexes through the same backend that the
    // application will install after the authority switch. Byte equality alone
    // cannot detect a target that is complete but unusable by Naidan.
    await promiseAllKeyed({
      settings: backend.loadSettings(),
      hierarchy: backend.loadHierarchy(),
      chatMetas: backend.listChatMetasRaw(),
      chatGroups: backend.listChatGroupsRaw(),
    });
    for await (const _binaryObject of backend.listBinaryObjects()) {
      // Enumeration validates every binary shard index without materializing
      // payloads into memory.
    }
    for await (const _volume of backend.listVolumes()) {
      // Enumeration validates every volume shard index.
    }
    return backend;
  }

  private async updateTransitionPhase<TOperation extends OpfsEncryptionOperationDto>({
    state,
    phase,
  }: {
    state: TransitioningStateWithOperation<TOperation>;
    phase: OpfsEncryptionOperationPhaseDto;
  }): Promise<TransitioningStateWithOperation<TOperation>> {
    const nextState = {
      ...state,
      sequence: state.sequence + 1,
      operation: {
        ...state.operation,
        phase,
      },
    } as TransitioningStateWithOperation<TOperation>;
    await this.stateStore.writeState({ state: nextState });
    return nextState;
  }

  private async writeStableState({
    previousState,
    activeEncryptedStoreId,
  }: {
    previousState: TransitioningOpfsEncryptionState;
    activeEncryptedStoreId: string;
  }): Promise<StableOpfsEncryptionState> {
    const state: StableOpfsEncryptionState = {
      formatVersion: 1,
      sequence: previousState.sequence + 1,
      state: 'encrypted',
      keySlots: previousState.keySlots,
      activeEncryptedStoreId,
    };
    await this.stateStore.writeState({ state });
    return state;
  }

  private requireFirstKeySlotId({
    state,
  }: {
    state: StableOpfsEncryptionState;
  }): string {
    const keySlot = state.keySlots[0];
    if (keySlot === undefined) {
      throw new Error('Encryption state contains no key slot');
    }
    return keySlot.id;
  }

  private async requireLatestStableStateForSession({
    session,
  }: {
    session: UnlockedOpfsEncryptionSession;
  }): Promise<StableOpfsEncryptionState> {
    const inspection = await this.stateStore.inspect();
    if (inspection.type !== 'encrypted' || inspection.state.state !== 'encrypted') {
      throw new Error('Encrypted storage state changed in another tab');
    }
    if (inspection.state.activeEncryptedStoreId !== session.state.activeEncryptedStoreId) {
      throw new Error('Active encrypted store changed in another tab');
    }
    return inspection.state;
  }

  private async requireLatestTransitioningState({
    expectedState,
  }: {
    expectedState: TransitioningOpfsEncryptionState;
  }): Promise<TransitioningOpfsEncryptionState> {
    const inspection = await this.stateStore.inspect();
    if (inspection.type !== 'encrypted' || inspection.state.state !== 'transitioning') {
      throw new Error('OPFS encryption transition state changed in another tab');
    }
    assertSameTransitionState({ expected: expectedState, actual: inspection.state });
    return inspection.state;
  }

  private async removeEncryptedStoresExcept({
    retainedStoreIds,
  }: {
    retainedStoreIds: ReadonlySet<string>;
  }): Promise<void> {
    let storesDirectory: FileSystemDirectoryHandle;
    try {
      storesDirectory = await this.storageRoot.getDirectoryHandle(
        ENCRYPTED_STORES_DIRECTORY_NAME,
      );
    } catch (error) {
      if (isNotFoundError({ error })) {
        return;
      }
      throw error;
    }

    for await (const entry of storesDirectory.values()) {
      if (!retainedStoreIds.has(entry.name)) {
        await removeDirectoryEntryIfPresent({
          directory: storesDirectory,
          name: entry.name,
        });
      }
    }
  }

  private async removeEncryptedStoresDirectory(): Promise<void> {
    await removeDirectoryEntryIfPresent({
      directory: this.storageRoot,
      name: ENCRYPTED_STORES_DIRECTORY_NAME,
    });
  }

  private async runRollback({
    message,
    originalError,
    rollback,
  }: {
    message: string;
    originalError: unknown;
    rollback: () => Promise<void>;
  }): Promise<void> {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError([originalError, rollbackError], message);
    }
  }

  private async withExclusiveTransitionLock<T>({
    run,
  }: {
    run: () => Promise<T>;
  }): Promise<T> {
    if (typeof navigator === 'undefined' || navigator.locks?.request === undefined) {
      throw new Error('OPFS encryption transitions require the Web Locks API');
    }
    return await navigator.locks.request(
      OPFS_STORAGE_SESSION_LOCK_KEY,
      { mode: 'exclusive' },
      run,
    );
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  assertSameTransitionState,
  isSourceAuthoritativePhase,
};
