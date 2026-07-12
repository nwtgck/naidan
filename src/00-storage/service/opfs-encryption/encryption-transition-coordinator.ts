import type {
  EncryptionOperationDto,
  EncryptionStateDto,
} from '@/00-storage/00-dto/encryption.dto';
import { chatToDto, settingsToDto } from '@/00-storage/mapper/mappers';
import type { BinaryObject, Volume } from '@/01-models/types';
import { toChatId } from '@/01-models/ids';
import { promiseAllKeyed } from '@/utils/promise';
import type { IStorageProvider } from '@/00-storage/service/interface';
import { PlainOPFSStorageBackend } from '@/00-storage/service/opfs/plain-opfs-storage-backend';
import { OPFS_STORAGE_SESSION_LOCK_KEY } from '@/00-storage/service/opfs/opfs-storage-session-lock';
import {
  type OpfsSpecialFileSystemType,
  type OpfsTransitionStorageBackend,
} from '@/00-storage/service/opfs/opfs-transition-backend';
import {
  copyStorageDirectory,
  createDirectStorageDirectoryTransferTarget,
  createStorageDirectoryTransferSource,
  type StorageDirectoryTransferEntry,
  type StorageDirectoryTransferSource,
} from '@/00-storage/service/storage-directory-transfer';
import type { StorageBinaryObjectReadHandle } from '@/00-storage/service/binary-object-io';
import { EncryptedOPFSStorageBackend } from './encrypted-opfs-storage-backend';
import { EncryptedStoreHeaderStore } from './encrypted-store-header-store';
import { createEncryptedStorageDirectoryTransferTarget } from './encrypted-storage-directory-transfer';
import {
  createEncryptionMaterial,
  createEncryptionOpaqueId,
  DEFAULT_PBKDF2_ITERATIONS,
  deriveEncryptedStoreRuntimeKeys,
  unlockStorageUnlockKeyWithPassphrase,
  unwrapStoreRootKey,
  wrapStoreRootKey,
} from './encryption-key-manager';
import {
  ENCRYPTED_STORES_DIRECTORY_NAME,
  EncryptionStateStore,
} from './encryption-state-store';
import { isNotFoundError, removeDirectoryEntryIfPresent } from './opfs-json-file';
import type { EncryptedStoreRuntimeKeys } from './types';


const DURABLE_SPECIAL_FILE_SYSTEM_TYPES: readonly OpfsSpecialFileSystemType[] = [
  'chat_wesh',
  'debug_wesh',
];

const ALL_SPECIAL_FILE_SYSTEM_TYPES: readonly OpfsSpecialFileSystemType[] = [
  ...DURABLE_SPECIAL_FILE_SYSTEM_TYPES,
  'tmp',
];

type StableEncryptionState = Extract<EncryptionStateDto, { state: 'encrypted' }>;
type TransitioningEncryptionState = Extract<EncryptionStateDto, { state: 'transitioning' }>;

export interface UnlockedOpfsEncryptionSession {
  readonly state: StableEncryptionState,
  readonly storageUnlockKey: Uint8Array,
  readonly unlockedKeySlotId: string,
  readonly backend: EncryptedOPFSStorageBackend,
}

export type EncryptionTransitionResult =
  | {
      readonly type: 'encrypted',
      readonly session: UnlockedOpfsEncryptionSession,
    }
  | {
      readonly type: 'plain',
      readonly backend: PlainOPFSStorageBackend,
    };

function normalizeJsonForComparison({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeJsonForComparison({ value: item }));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  for (const [key, entryValue] of entries) {
    normalized[key] = normalizeJsonForComparison({ value: entryValue });
  }
  return normalized;
}

function stringifyComparable({ value }: { value: unknown }): string {
  return JSON.stringify(normalizeJsonForComparison({ value }));
}

function collectJsonDifferencePaths({
  source,
  target,
  path,
  output,
}: {
  source: unknown,
  target: unknown,
  path: string,
  output: string[],
}): void {
  if (output.length >= 8 || Object.is(source, target)) {
    return;
  }
  if (Array.isArray(source) && Array.isArray(target)) {
    if (source.length !== target.length) {
      output.push(`${path}.length`);
      return;
    }
    for (const [index, sourceValue] of source.entries()) {
      collectJsonDifferencePaths({
        source: sourceValue,
        target: target[index],
        path: `${path}[${index}]`,
        output,
      });
    }
    return;
  }
  if (
    source !== null
    && target !== null
    && typeof source === 'object'
    && typeof target === 'object'
    && !Array.isArray(source)
    && !Array.isArray(target)
  ) {
    const sourceObject = source as Record<string, unknown>;
    const targetObject = target as Record<string, unknown>;
    const keys = new Set([
      ...Object.keys(sourceObject),
      ...Object.keys(targetObject),
    ]);
    for (const key of [...keys].sort()) {
      collectJsonDifferencePaths({
        source: sourceObject[key],
        target: targetObject[key],
        path: `${path}.${key}`,
        output,
      });
    }
    return;
  }
  output.push(path);
}

function describeJsonDifferences({
  source,
  target,
}: {
  source: unknown,
  target: unknown,
}): string {
  const paths: string[] = [];
  collectJsonDifferencePaths({
    source: normalizeJsonForComparison({ value: source }),
    target: normalizeJsonForComparison({ value: target }),
    path: '$',
    output: paths,
  });
  return paths.length === 0 ? 'unknown fields' : paths.join(', ');
}


function isSourceAuthoritativePhase({
  phase,
}: {
  phase: EncryptionOperationDto['phase'],
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

async function collectBinaryObjects({
  provider,
}: {
  provider: IStorageProvider,
}): Promise<Map<string, BinaryObject>> {
  const result = new Map<string, BinaryObject>();
  for await (const binaryObject of provider.listBinaryObjects()) {
    result.set(String(binaryObject.id), binaryObject);
  }
  return result;
}

async function collectVolumes({
  provider,
}: {
  provider: IStorageProvider,
}): Promise<Map<string, Volume>> {
  const result = new Map<string, Volume>();
  for await (const volume of provider.listVolumes()) {
    result.set(String(volume.id), volume);
  }
  return result;
}

async function readNextBytes({
  reader,
}: {
  reader: ReadableStreamDefaultReader<Uint8Array>,
}): Promise<Uint8Array | undefined> {
  const result = await reader.read();
  return result.done ? undefined : result.value;
}

async function verifyStreamsEqual({
  source,
  target,
}: {
  source: ReadableStream<Uint8Array>,
  target: ReadableStream<Uint8Array>,
}): Promise<void> {
  const sourceReader = source.getReader();
  const targetReader = target.getReader();
  let sourceBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let targetBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let sourceDone = false;
  let targetDone = false;

  try {
    while (true) {
      if (sourceBuffer.byteLength === 0 && !sourceDone) {
        const value = await readNextBytes({ reader: sourceReader });
        if (value === undefined) {
          sourceDone = true;
        } else {
          sourceBuffer = value;
        }
      }
      if (targetBuffer.byteLength === 0 && !targetDone) {
        const value = await readNextBytes({ reader: targetReader });
        if (value === undefined) {
          targetDone = true;
        } else {
          targetBuffer = value;
        }
      }

      if (sourceDone && targetDone && sourceBuffer.byteLength === 0 && targetBuffer.byteLength === 0) {
        return;
      }
      if (
        (sourceDone && sourceBuffer.byteLength === 0)
        !== (targetDone && targetBuffer.byteLength === 0)
      ) {
        throw new Error('Transferred file length does not match its source');
      }
      if (sourceBuffer.byteLength === 0 || targetBuffer.byteLength === 0) {
        continue;
      }

      const comparedLength = Math.min(sourceBuffer.byteLength, targetBuffer.byteLength);
      for (let index = 0; index < comparedLength; index += 1) {
        if (sourceBuffer[index] !== targetBuffer[index]) {
          throw new Error('Transferred file contents do not match their source');
        }
      }
      sourceBuffer = sourceBuffer.subarray(comparedLength);
      targetBuffer = targetBuffer.subarray(comparedLength);
    }
  } finally {
    await Promise.allSettled([
      sourceReader.cancel(),
      targetReader.cancel(),
    ]);
    sourceReader.releaseLock();
    targetReader.releaseLock();
  }
}

async function verifyBinaryHandlesEqual({
  source,
  target,
}: {
  source: StorageBinaryObjectReadHandle,
  target: StorageBinaryObjectReadHandle,
}): Promise<void> {
  try {
    if (source.size !== target.size || source.mimeType !== target.mimeType) {
      throw new Error('Transferred binary object metadata does not match its source');
    }
    await verifyStreamsEqual({
      source: source.stream({ start: 0, end: undefined, signal: undefined }),
      target: target.stream({ start: 0, end: undefined, signal: undefined }),
    });
  } finally {
    await Promise.allSettled([source.close(), target.close()]);
  }
}

async function collectDirectoryEntries({
  source,
  path,
}: {
  source: StorageDirectoryTransferSource,
  path: string,
}): Promise<Map<string, StorageDirectoryTransferEntry>> {
  const result = new Map<string, StorageDirectoryTransferEntry>();
  for await (const entry of source.readDirectory({ path })) {
    result.set(entry.name, entry);
  }
  return result;
}

function joinDirectoryPath({ parent, name }: { parent: string, name: string }): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

async function verifyDirectoriesEqual({
  source,
  target,
  path = '/',
}: {
  source: StorageDirectoryTransferSource,
  target: StorageDirectoryTransferSource,
  path?: string,
}): Promise<void> {
  const sourceEntries = await collectDirectoryEntries({ source, path });
  const targetEntries = await collectDirectoryEntries({ source: target, path });
  if (sourceEntries.size !== targetEntries.size) {
    throw new Error(`Transferred directory entry count differs at ${path}`);
  }

  const names = [...sourceEntries.keys()].sort();
  for (const name of names) {
    const sourceEntry = sourceEntries.get(name);
    const targetEntry = targetEntries.get(name);
    if (sourceEntry === undefined || targetEntry === undefined || sourceEntry.type !== targetEntry.type) {
      throw new Error(`Transferred directory entry differs at ${joinDirectoryPath({ parent: path, name })}`);
    }
    const childPath = joinDirectoryPath({ parent: path, name });
    switch (sourceEntry.type) {
    case 'directory':
      await verifyDirectoriesEqual({ source, target, path: childPath });
      break;
    case 'symlink':
      if (
        targetEntry.type !== 'symlink'
        || sourceEntry.targetPath !== targetEntry.targetPath
        || sourceEntry.modifiedAt !== targetEntry.modifiedAt
      ) {
        throw new Error(`Transferred symbolic link differs at ${childPath}`);
      }
      break;
    case 'file':
      if (
        targetEntry.type !== 'file'
        || sourceEntry.size !== targetEntry.size
        || sourceEntry.modifiedAt !== targetEntry.modifiedAt
      ) {
        throw new Error(`Transferred file metadata differs at ${childPath}`);
      }
      await verifyStreamsEqual({
        source: await sourceEntry.open(),
        target: await targetEntry.open(),
      });
      break;
    default: {
      const _ex: never = sourceEntry;
      throw new Error(`Unhandled transfer entry: ${String(_ex)}`);
    }
    }
  }
}

async function verifyProviderCopy({
  source,
  target,
}: {
  source: OpfsTransitionStorageBackend,
  target: OpfsTransitionStorageBackend,
}): Promise<void> {
  const {
    sourceHierarchy,
    targetHierarchy,
    sourceSettings,
    targetSettings,
  } = await promiseAllKeyed({
    sourceHierarchy: source.loadHierarchy(),
    targetHierarchy: target.loadHierarchy(),
    sourceSettings: source.loadSettings(),
    targetSettings: target.loadSettings(),
  });
  if (stringifyComparable({ value: sourceHierarchy }) !== stringifyComparable({ value: targetHierarchy })) {
    throw new Error('Transferred hierarchy does not match its source');
  }
  if (
    stringifyComparable({ value: sourceSettings === null ? null : settingsToDto({ domain: sourceSettings }) })
    !== stringifyComparable({ value: targetSettings === null ? null : settingsToDto({ domain: targetSettings }) })
  ) {
    const sourceDto = sourceSettings === null ? null : settingsToDto({ domain: sourceSettings });
    const targetDto = targetSettings === null ? null : settingsToDto({ domain: targetSettings });
    throw new Error(
      `Transferred settings do not match their source (${describeJsonDifferences({
        source: sourceDto,
        target: targetDto,
      })})`,
    );
  }

  const {
    sourceMetas,
    targetMetas,
    sourceGroups,
    targetGroups,
  } = await promiseAllKeyed({
    sourceMetas: source.listChatMetasRaw(),
    targetMetas: target.listChatMetasRaw(),
    sourceGroups: source.listChatGroupsRaw(),
    targetGroups: target.listChatGroupsRaw(),
  });
  sourceMetas.sort((left, right) => left.id.localeCompare(right.id));
  targetMetas.sort((left, right) => left.id.localeCompare(right.id));
  sourceGroups.sort((left, right) => left.id.localeCompare(right.id));
  targetGroups.sort((left, right) => left.id.localeCompare(right.id));
  if (stringifyComparable({ value: sourceMetas }) !== stringifyComparable({ value: targetMetas })) {
    throw new Error('Transferred chat metadata does not match its source');
  }
  if (stringifyComparable({ value: sourceGroups }) !== stringifyComparable({ value: targetGroups })) {
    throw new Error('Transferred chat groups do not match their source');
  }

  for (const sourceMeta of sourceMetas) {
    const { sourceChat, targetChat } = await promiseAllKeyed({
      sourceChat: source.loadChat({ id: toChatId({ raw: sourceMeta.id }) }),
      targetChat: target.loadChat({ id: toChatId({ raw: sourceMeta.id }) }),
    });
    if (
      stringifyComparable({ value: sourceChat === null ? null : chatToDto({ domain: sourceChat }) })
      !== stringifyComparable({ value: targetChat === null ? null : chatToDto({ domain: targetChat }) })
    ) {
      throw new Error(`Transferred chat does not match its source: ${String(sourceMeta.id)}`);
    }
  }

  const { sourceBinaryObjects, targetBinaryObjects } = await promiseAllKeyed({
    sourceBinaryObjects: collectBinaryObjects({ provider: source }),
    targetBinaryObjects: collectBinaryObjects({ provider: target }),
  });
  if (sourceBinaryObjects.size !== targetBinaryObjects.size) {
    throw new Error('Transferred binary-object count does not match its source');
  }
  for (const [id, sourceBinaryObject] of sourceBinaryObjects) {
    const targetBinaryObject = targetBinaryObjects.get(id);
    if (
      targetBinaryObject === undefined
      || stringifyComparable({ value: sourceBinaryObject }) !== stringifyComparable({ value: targetBinaryObject })
    ) {
      throw new Error(`Transferred binary-object metadata differs: ${id}`);
    }
    const { sourceHandle, targetHandle } = await promiseAllKeyed({
      sourceHandle: source.openBinaryObject({ binaryObjectId: sourceBinaryObject.id }),
      targetHandle: target.openBinaryObject({ binaryObjectId: sourceBinaryObject.id }),
    });
    if (sourceHandle === null || targetHandle === null) {
      await Promise.allSettled([sourceHandle?.close(), targetHandle?.close()]);
      throw new Error(`Transferred binary-object payload is missing: ${id}`);
    }
    await verifyBinaryHandlesEqual({ source: sourceHandle, target: targetHandle });
  }

  const { sourceVolumes, targetVolumes } = await promiseAllKeyed({
    sourceVolumes: collectVolumes({ provider: source }),
    targetVolumes: collectVolumes({ provider: target }),
  });
  if (sourceVolumes.size !== targetVolumes.size) {
    throw new Error('Transferred volume count does not match its source');
  }
  for (const [id, sourceVolume] of sourceVolumes) {
    const targetVolume = targetVolumes.get(id);
    if (
      targetVolume === undefined
      || stringifyComparable({ value: sourceVolume }) !== stringifyComparable({ value: targetVolume })
    ) {
      throw new Error(`Transferred volume metadata differs: ${id}`);
    }
    switch (sourceVolume.type) {
    case 'host':
      continue;
    case 'opfs':
      break;
    default: {
      const _ex: never = sourceVolume.type;
      throw new Error(`Unhandled volume type: ${String(_ex)}`);
    }
    }
    const { sourceAccess, targetAccess } = await promiseAllKeyed({
      sourceAccess: source.openVolume({ volumeId: sourceVolume.id }),
      targetAccess: target.openVolume({ volumeId: targetVolume.id }),
    });
    if (sourceAccess === null || targetAccess === null) {
      throw new Error(`Transferred OPFS volume is missing: ${id}`);
    }
    await verifyDirectoriesEqual({
      source: await createStorageDirectoryTransferSource({ access: sourceAccess }),
      target: await createStorageDirectoryTransferSource({ access: targetAccess }),
    });
  }

  for (const type of DURABLE_SPECIAL_FILE_SYSTEM_TYPES) {
    const { sourceAccess, targetAccess } = await promiseAllKeyed({
      sourceAccess: source.openSpecialFileSystemForTransition({ type, create: false }),
      targetAccess: target.openSpecialFileSystemForTransition({ type, create: false }),
    });
    if (sourceAccess === null && targetAccess === null) {
      continue;
    }
    if (sourceAccess === null || targetAccess === null) {
      throw new Error(`Transferred ${type} filesystem presence differs`);
    }
    await verifyDirectoriesEqual({
      source: await createStorageDirectoryTransferSource({ access: sourceAccess }),
      target: await createStorageDirectoryTransferSource({ access: targetAccess }),
    });
  }
}

async function copyProviderData({
  source,
  target,
  signal,
}: {
  source: OpfsTransitionStorageBackend,
  target: OpfsTransitionStorageBackend,
  signal: AbortSignal | undefined,
}): Promise<void> {
  signal?.throwIfAborted();
  const sourceSettings = await source.loadSettings();
  await target.restore({ snapshot: await source.dump() });
  if (sourceSettings === null) {
    // StorageSnapshot requires Settings and dump() therefore supplies migration
    // defaults when settings.json does not exist. A transition must preserve the
    // absence itself so an unfinished first-run onboarding is not converted into
    // a persisted, apparently completed configuration.
    await target.removeSettingsForTransition();
  }

  for await (const volume of source.listVolumes()) {
    signal?.throwIfAborted();
    const sourceAccess = await source.openVolume({ volumeId: volume.id });
    if (sourceAccess === null) {
      throw new Error(`Transition source volume is missing: ${String(volume.id)}`);
    }
    await target.importVolumeForTransition({
      volume,
      sourceAccess,
      signal,
    });
  }

  for (const type of DURABLE_SPECIAL_FILE_SYSTEM_TYPES) {
    signal?.throwIfAborted();
    const sourceAccess = await source.openSpecialFileSystemForTransition({ type, create: false });
    if (sourceAccess === null) {
      await target.removeSpecialFileSystemForTransition({ type });
      continue;
    }
    await target.removeSpecialFileSystemForTransition({ type });
    const targetAccess = await target.openSpecialFileSystemForTransition({ type, create: true });
    if (targetAccess === null) {
      throw new Error(`Transition target could not create ${type} filesystem`);
    }
    const targetTransfer = (() => {
      switch (targetAccess.type) {
      case 'direct_directory':
        return createDirectStorageDirectoryTransferTarget({ root: targetAccess.handle });
      case 'encrypted_directory':
        return createEncryptedStorageDirectoryTransferTarget({ access: targetAccess });
      default: {
        const _ex: never = targetAccess;
        throw new Error(`Unhandled transition target access: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
    })();
    await copyStorageDirectory({
      source: await createStorageDirectoryTransferSource({ access: sourceAccess }),
      target: targetTransfer,
      signal,
    });
  }
}


export class EncryptionTransitionCoordinator {
  constructor({ storageRoot }: { storageRoot: FileSystemDirectoryHandle }) {
    this.storageRoot = storageRoot;
    this.stateStore = new EncryptionStateStore({ storageRoot });
    this.headerStore = new EncryptedStoreHeaderStore({ storageRoot });
  }

  private readonly storageRoot: FileSystemDirectoryHandle;
  private readonly stateStore: EncryptionStateStore;
  private readonly headerStore: EncryptedStoreHeaderStore;

  async enableEncryption({
    passphrase,
    signal,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
  }): Promise<EncryptionTransitionResult> {
    return await this.withExclusiveTransitionLock({
      run: async () => {
        const source = new PlainOPFSStorageBackend();
        await source.init();
        await source.assertEncryptionTransitionSupported();
        await this.removeEncryptedStoresExcept({ retainedStoreIds: new Set() });

        const encryptedStoreId = createEncryptionOpaqueId();
        const material = await createEncryptionMaterial({
          passphrase,
          pbkdf2Iterations: DEFAULT_PBKDF2_ITERATIONS,
        });
        let transitionState: TransitioningEncryptionState | undefined;
        let succeeded = false;
        try {
          const target = await this.createEncryptedBackend({
            encryptedStoreId,
            storageUnlockKey: material.storageUnlockKey,
            storeRootKey: material.storeRootKey,
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
          const stableState = await this.runEncryptingTransition({
            state: transitionState,
            source,
            target,
            signal,
          });
          succeeded = true;
          return {
            type: 'encrypted',
            session: {
              state: stableState,
              storageUnlockKey: material.storageUnlockKey,
              unlockedKeySlotId: material.keySlots[0]?.id ?? (() => {
                throw new Error('Created encryption material has no keyslot');
              })(),
              backend: target,
            },
          };
        } catch (error) {
          if (transitionState === undefined || isSourceAuthoritativePhase({ phase: transitionState.operation.phase })) {
            await this.rollbackEncryptingToPlain({
              targetEncryptedStoreId: encryptedStoreId,
              originalError: error,
            });
          }
          throw error;
        } finally {
          material.storeRootKey.fill(0);
          if (!succeeded) {
            material.storageUnlockKey.fill(0);
          }
        }
      },
    });
  }

  async disableEncryption({
    session,
    signal,
  }: {
    session: UnlockedOpfsEncryptionSession,
    signal: AbortSignal | undefined,
  }): Promise<EncryptionTransitionResult> {
    return await this.withExclusiveTransitionLock({
      run: async () => {
        const latestState = await this.requireLatestStableStateForSession({ session });
        const target = new PlainOPFSStorageBackend();
        await target.init();
        await target.assertEncryptionTransitionSupported();
        await target.clearPlainDataForTransition();
        for (const type of ALL_SPECIAL_FILE_SYSTEM_TYPES) {
          await target.removeSpecialFileSystemForTransition({ type });
        }
        const transitionState: TransitioningEncryptionState = {
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
        try {
          await this.stateStore.writeState({ state: transitionState });
          await copyProviderData({ source: session.backend, target, signal });
          await verifyProviderCopy({ source: session.backend, target });
          await this.updateTransitionPhase({ state: transitionState, phase: 'cleaning_up_source' });
          await this.headerStore.removeStore({
            encryptedStoreId: latestState.activeEncryptedStoreId,
          });
          await this.removeEncryptedStoresDirectory();
          await this.stateStore.removeAll();
          return { type: 'plain', backend: target };
        } catch (error) {
          if (isSourceAuthoritativePhase({ phase: transitionState.operation.phase })) {
            await this.rollbackDecryptingToEncrypted({
              state: transitionState,
              target,
              originalError: error,
            });
          }
          throw error;
        }
      },
    });
  }

  async reencrypt({
    session,
    signal,
  }: {
    session: UnlockedOpfsEncryptionSession,
    signal: AbortSignal | undefined,
  }): Promise<EncryptionTransitionResult> {
    return await this.withExclusiveTransitionLock({
      run: async () => {
        const latestState = await this.requireLatestStableStateForSession({ session });
        await this.removeEncryptedStoresExcept({
          retainedStoreIds: new Set([latestState.activeEncryptedStoreId]),
        });
        const targetEncryptedStoreId = createEncryptionOpaqueId();
        const targetStoreRootKey = crypto.getRandomValues(new Uint8Array(32));
        let target: EncryptedOPFSStorageBackend;
        try {
          target = await this.createEncryptedBackend({
            encryptedStoreId: targetEncryptedStoreId,
            storageUnlockKey: session.storageUnlockKey,
            storeRootKey: targetStoreRootKey,
            replace: true,
          });
        } catch (error) {
          await this.runRollback({
            message: 'Failed to remove an incomplete OPFS re-encryption target',
            originalError: error,
            rollback: async () => {
              await this.headerStore.removeStore({
                encryptedStoreId: targetEncryptedStoreId,
              });
            },
          });
          throw error;
        } finally {
          targetStoreRootKey.fill(0);
        }
        const transitionState: TransitioningEncryptionState = {
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
        try {
          await this.stateStore.writeState({ state: transitionState });
          await copyProviderData({ source: session.backend, target, signal });
          await verifyProviderCopy({ source: session.backend, target });
          await this.updateTransitionPhase({ state: transitionState, phase: 'cleaning_up_source' });
          await this.headerStore.removeStore({
            encryptedStoreId: latestState.activeEncryptedStoreId,
          });
          const stableState = await this.writeStableState({
            previousState: transitionState,
            activeEncryptedStoreId: targetEncryptedStoreId,
          });
          return {
            type: 'encrypted',
            session: {
              state: stableState,
              storageUnlockKey: session.storageUnlockKey,
              unlockedKeySlotId: session.unlockedKeySlotId,
              backend: target,
            },
          };
        } catch (error) {
          if (isSourceAuthoritativePhase({ phase: transitionState.operation.phase })) {
            await this.rollbackReencryptingToSource({
              state: transitionState,
              originalError: error,
            });
          }
          throw error;
        }
      },
    });
  }

  async resumeWithPassphrase({
    state,
    passphrase,
    signal,
  }: {
    state: TransitioningEncryptionState,
    passphrase: string,
    signal: AbortSignal | undefined,
  }): Promise<EncryptionTransitionResult> {
    const { storageUnlockKey, keySlotId } = await unlockStorageUnlockKeyWithPassphrase({
      keySlots: state.keySlots,
      passphrase,
    });
    let retainedByEncryptedSession = false;
    try {
      const result = await this.resume({
        state,
        storageUnlockKey,
        unlockedKeySlotId: keySlotId,
        signal,
      });
      retainedByEncryptedSession = result.type === 'encrypted';
      return result;
    } finally {
      if (!retainedByEncryptedSession) {
        storageUnlockKey.fill(0);
      }
    }
  }


  private async resume({
    state,
    storageUnlockKey,
    unlockedKeySlotId,
    signal,
  }: {
    state: TransitioningEncryptionState,
    storageUnlockKey: Uint8Array,
    unlockedKeySlotId: string,
    signal: AbortSignal | undefined,
  }): Promise<EncryptionTransitionResult> {
    return await this.withExclusiveTransitionLock({
      run: async () => {
        switch (state.operation.type) {
        case 'encrypting': {
          const source = new PlainOPFSStorageBackend();
          await source.init();
          const target = await this.openEncryptedTransitionTargetForPhase({
            encryptedStoreId: state.operation.targetEncryptedStoreId,
            storageUnlockKey,
            phase: state.operation.phase,
          });
          try {
            const stableState = await this.runEncryptingTransition({ state, source, target, signal });
            return {
              type: 'encrypted',
              session: {
                state: stableState,
                storageUnlockKey,
                unlockedKeySlotId,
                backend: target,
              },
            };
          } catch (error) {
            if (isSourceAuthoritativePhase({ phase: state.operation.phase })) {
              await this.rollbackEncryptingToPlain({
                targetEncryptedStoreId: state.operation.targetEncryptedStoreId,
                originalError: error,
              });
            }
            throw error;
          }
        }
        case 'decrypting': {
          const target = new PlainOPFSStorageBackend();
          await target.init();
          const phase = state.operation.phase;
          try {
            switch (phase) {
            case 'building_target': {
              const source = await this.openEncryptedBackend({
                encryptedStoreId: state.operation.sourceEncryptedStoreId,
                storageUnlockKey,
              });
              await target.assertEncryptionTransitionSupported();
              await target.clearPlainDataForTransition();
              for (const type of ALL_SPECIAL_FILE_SYSTEM_TYPES) {
                await target.removeSpecialFileSystemForTransition({ type });
              }
              await copyProviderData({ source, target, signal });
              await verifyProviderCopy({ source, target });
              await this.updateTransitionPhase({ state, phase: 'cleaning_up_source' });
              break;
            }
            case 'cleaning_up_source':
              break;
            default: {
              const _ex: never = phase;
              throw new Error(`Unhandled decrypting phase: ${String(_ex)}`);
            }
            }
            await this.headerStore.removeStore({
              encryptedStoreId: state.operation.sourceEncryptedStoreId,
            });
            await this.removeEncryptedStoresDirectory();
            await this.stateStore.removeAll();
            return { type: 'plain', backend: target };
          } catch (error) {
            if (isSourceAuthoritativePhase({ phase: state.operation.phase })) {
              await this.rollbackDecryptingToEncrypted({
                state,
                target,
                originalError: error,
              });
            }
            throw error;
          }
        }
        case 'reencrypting': {
          const phase = state.operation.phase;
          const target = await this.openEncryptedTransitionTargetForPhase({
            encryptedStoreId: state.operation.targetEncryptedStoreId,
            storageUnlockKey,
            phase,
          });
          try {
            switch (phase) {
            case 'building_target': {
              const source = await this.openEncryptedBackend({
                encryptedStoreId: state.operation.sourceEncryptedStoreId,
                storageUnlockKey,
              });
              await copyProviderData({ source, target, signal });
              await verifyProviderCopy({ source, target });
              await this.updateTransitionPhase({ state, phase: 'cleaning_up_source' });
              break;
            }
            case 'cleaning_up_source':
              break;
            default: {
              const _ex: never = phase;
              throw new Error(`Unhandled re-encrypting phase: ${String(_ex)}`);
            }
            }
            await this.headerStore.removeStore({
              encryptedStoreId: state.operation.sourceEncryptedStoreId,
            });
            const stableState = await this.writeStableState({
              previousState: state,
              activeEncryptedStoreId: state.operation.targetEncryptedStoreId,
            });
            return {
              type: 'encrypted',
              session: {
                state: stableState,
                storageUnlockKey,
                unlockedKeySlotId,
                backend: target,
              },
            };
          } catch (error) {
            if (isSourceAuthoritativePhase({ phase: state.operation.phase })) {
              await this.rollbackReencryptingToSource({
                state,
                originalError: error,
              });
            }
            throw error;
          }
        }
        default: {
          const _ex: never = state.operation;
          throw new Error(`Unhandled encryption transition: ${String(_ex)}`);
        }
        }
      },
    });
  }

  private async runEncryptingTransition({
    state,
    source,
    target,
    signal,
  }: {
    state: TransitioningEncryptionState,
    source: PlainOPFSStorageBackend,
    target: EncryptedOPFSStorageBackend,
    signal: AbortSignal | undefined,
  }): Promise<StableEncryptionState> {
    const operation = state.operation;
    switch (operation.type) {
    case 'encrypting':
      break;
    case 'decrypting':
    case 'reencrypting':
      throw new Error('Encrypting transition runner received another operation type');
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled encryption operation: ${((_ex satisfies never) as { readonly type: string }).type}`);
    }
    }

    const phase = operation.phase;
    switch (phase) {
    case 'building_target':
      await copyProviderData({ source, target, signal });
      await verifyProviderCopy({ source, target });
      await this.updateTransitionPhase({ state, phase: 'cleaning_up_source' });
      break;
    case 'cleaning_up_source':
      break;
    default: {
      const _ex: never = phase;
      throw new Error(`Unhandled encrypting phase: ${String(_ex)}`);
    }
    }
    await source.clearPlainDataForTransition();
    for (const type of ALL_SPECIAL_FILE_SYSTEM_TYPES) {
      await source.removeSpecialFileSystemForTransition({ type });
    }
    return await this.writeStableState({
      previousState: state,
      activeEncryptedStoreId: operation.targetEncryptedStoreId,
    });
  }

  private async updateTransitionPhase({
    state,
    phase,
  }: {
    state: TransitioningEncryptionState,
    phase: EncryptionOperationDto['phase'],
  }): Promise<void> {
    const nextState: TransitioningEncryptionState = {
      ...state,
      sequence: state.sequence + 1,
      operation: {
        ...state.operation,
        phase,
      },
    };
    await this.stateStore.writeState({ state: nextState });
    state.sequence = nextState.sequence;
    state.operation.phase = nextState.operation.phase;
  }

  private async writeStableState({
    previousState,
    activeEncryptedStoreId,
  }: {
    previousState: TransitioningEncryptionState,
    activeEncryptedStoreId: string,
  }): Promise<StableEncryptionState> {
    const stableState: StableEncryptionState = {
      formatVersion: 1,
      sequence: previousState.sequence + 1,
      state: 'encrypted',
      keySlots: previousState.keySlots,
      activeEncryptedStoreId,
    };
    await this.stateStore.writeState({ state: stableState });
    return stableState;
  }

  private async rollbackEncryptingToPlain({
    targetEncryptedStoreId,
    originalError,
  }: {
    targetEncryptedStoreId: string,
    originalError: unknown,
  }): Promise<void> {
    await this.runRollback({
      message: 'Failed to roll back an interrupted OPFS encryption attempt',
      originalError,
      rollback: async () => {
        await this.headerStore.removeStore({ encryptedStoreId: targetEncryptedStoreId });
        await this.removeEncryptedStoresDirectory();
        await this.stateStore.removeAll();
      },
    });
  }

  private async rollbackDecryptingToEncrypted({
    state,
    target,
    originalError,
  }: {
    state: TransitioningEncryptionState,
    target: PlainOPFSStorageBackend,
    originalError: unknown,
  }): Promise<void> {
    const operation = (() => {
      switch (state.operation.type) {
      case 'decrypting':
        return state.operation;
      case 'encrypting':
      case 'reencrypting':
        throw new Error('Decrypting rollback received another operation type');
      default: {
        const _ex: never = state.operation;
        throw new Error(`Unhandled encryption operation: ${String(_ex)}`);
      }
      }
    })();
    await this.runRollback({
      message: 'Failed to roll back an interrupted OPFS decryption attempt',
      originalError,
      rollback: async () => {
        await target.clearPlainDataForTransition();
        for (const type of ALL_SPECIAL_FILE_SYSTEM_TYPES) {
          await target.removeSpecialFileSystemForTransition({ type });
        }
        await this.writeStableState({
          previousState: state,
          activeEncryptedStoreId: operation.sourceEncryptedStoreId,
        });
      },
    });
  }

  private async rollbackReencryptingToSource({
    state,
    originalError,
  }: {
    state: TransitioningEncryptionState,
    originalError: unknown,
  }): Promise<void> {
    const operation = (() => {
      switch (state.operation.type) {
      case 'reencrypting':
        return state.operation;
      case 'encrypting':
      case 'decrypting':
        throw new Error('Re-encrypting rollback received another operation type');
      default: {
        const _ex: never = state.operation;
        throw new Error(`Unhandled encryption operation: ${String(_ex)}`);
      }
      }
    })();
    await this.runRollback({
      message: 'Failed to roll back an interrupted OPFS re-encryption attempt',
      originalError,
      rollback: async () => {
        await this.headerStore.removeStore({
          encryptedStoreId: operation.targetEncryptedStoreId,
        });
        await this.writeStableState({
          previousState: state,
          activeEncryptedStoreId: operation.sourceEncryptedStoreId,
        });
      },
    });
  }

  private async runRollback({
    message,
    originalError,
    rollback,
  }: {
    message: string,
    originalError: unknown,
    rollback: () => Promise<void>,
  }): Promise<void> {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [originalError, rollbackError],
        message,
      );
    }
  }


  private async openEncryptedTransitionTargetForPhase({
    encryptedStoreId,
    storageUnlockKey,
    phase,
  }: {
    encryptedStoreId: string,
    storageUnlockKey: Uint8Array,
    phase: EncryptionOperationDto['phase'],
  }): Promise<EncryptedOPFSStorageBackend> {
    switch (phase) {
    case 'building_target':
      return await this.recreateEncryptedTransitionTarget({
        encryptedStoreId,
        storageUnlockKey,
      });
    case 'cleaning_up_source':
      return await this.openEncryptedBackend({
        encryptedStoreId,
        storageUnlockKey,
      });
    default: {
      const _ex: never = phase;
      throw new Error(`Unhandled encryption operation phase: ${String(_ex)}`);
    }
    }
  }

  private async recreateEncryptedTransitionTarget({
    encryptedStoreId,
    storageUnlockKey,
  }: {
    encryptedStoreId: string,
    storageUnlockKey: Uint8Array,
  }): Promise<EncryptedOPFSStorageBackend> {
    const storeRootKey = crypto.getRandomValues(new Uint8Array(32));
    try {
      return await this.createEncryptedBackend({
        encryptedStoreId,
        storageUnlockKey,
        storeRootKey,
        replace: true,
      });
    } finally {
      storeRootKey.fill(0);
    }
  }

  private async createEncryptedBackend({
    encryptedStoreId,
    storageUnlockKey,
    storeRootKey,
    replace,
  }: {
    encryptedStoreId: string,
    storageUnlockKey: Uint8Array,
    storeRootKey: Uint8Array,
    replace: boolean,
  }): Promise<EncryptedOPFSStorageBackend> {
    if (replace) {
      await this.headerStore.removeStore({ encryptedStoreId });
    }
    await this.headerStore.write({
      header: {
        formatVersion: 1,
        sequence: 0,
        encryptedStoreId,
        wrappedStoreRootKey: await wrapStoreRootKey({
          storageUnlockKey,
          storeRootKey,
          encryptedStoreId,
        }),
      },
    });
    const keys = await deriveEncryptedStoreRuntimeKeys({
      storeRootKey,
      encryptedStoreId,
    });
    const storeDirectory = await this.headerStore.getStoreDirectory({
      encryptedStoreId,
      create: false,
    });
    const backend = new EncryptedOPFSStorageBackend({ encryptedStoreId, storeDirectory, keys });
    await backend.initializeNewStore();
    return backend;
  }

  private async openEncryptedBackend({
    encryptedStoreId,
    storageUnlockKey,
  }: {
    encryptedStoreId: string,
    storageUnlockKey: Uint8Array,
  }): Promise<EncryptedOPFSStorageBackend> {
    const header = await this.headerStore.read({ encryptedStoreId });
    if (header === undefined || header.encryptedStoreId !== encryptedStoreId) {
      throw new Error(`Encrypted transition store header is missing: ${encryptedStoreId}`);
    }
    const storeRootKey = await unwrapStoreRootKey({ storageUnlockKey, header });
    let keys: EncryptedStoreRuntimeKeys;
    try {
      keys = await deriveEncryptedStoreRuntimeKeys({
        storeRootKey,
        encryptedStoreId,
      });
    } finally {
      storeRootKey.fill(0);
    }
    const storeDirectory = await this.headerStore.getStoreDirectory({
      encryptedStoreId,
      create: false,
    });
    const backend = new EncryptedOPFSStorageBackend({ encryptedStoreId, storeDirectory, keys });
    await backend.init();
    return backend;
  }

  private async removeEncryptedStoresExcept({
    retainedStoreIds,
  }: {
    retainedStoreIds: ReadonlySet<string>,
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
      if (retainedStoreIds.has(entry.name)) {
        continue;
      }
      await removeDirectoryEntryIfPresent({
        directory: storesDirectory,
        name: entry.name,
      });
    }
  }

  private async removeEncryptedStoresDirectory(): Promise<void> {
    await removeDirectoryEntryIfPresent({
      directory: this.storageRoot,
      name: ENCRYPTED_STORES_DIRECTORY_NAME,
    });
  }

  private async requireLatestStableStateForSession({
    session,
  }: {
    session: UnlockedOpfsEncryptionSession,
  }): Promise<StableEncryptionState> {
    const inspection = await this.stateStore.inspect();
    if (inspection.type !== 'encrypted' || inspection.state.state !== 'encrypted') {
      throw new Error('Encrypted storage state changed in another tab');
    }
    if (inspection.state.activeEncryptedStoreId !== session.state.activeEncryptedStoreId) {
      throw new Error('Active encrypted store changed in another tab');
    }
    return inspection.state;
  }

  private async withExclusiveTransitionLock<T>({
    run,
  }: {
    run: () => Promise<T>,
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
  normalizeJsonForComparison,
  stringifyComparable,
  describeJsonDifferences,
  copyProviderData,
  verifyDirectoriesEqual,
  verifyProviderCopy,
  verifyStreamsEqual,
};
