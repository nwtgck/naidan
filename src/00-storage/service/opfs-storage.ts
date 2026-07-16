import type {
  BinaryObject,
  Chat,
  ChatContent,
  ChatGroup,
  ChatMeta,
  Settings,
  SidebarItem,
  StorageSnapshot,
  Volume,
  VolumeType,
} from '@/01-models/types';
import type {
  BinaryObjectId,
  ChatGroupId,
  ChatId,
  VolumeId,
} from '@/01-models/ids';
import type {
  ChatGroupDto,
  ChatMetaDto,
  HierarchyDto,
} from '@/00-storage/00-dto/dto';
import type {
  StorageBinaryObjectReadHandle,
  StorageBinaryObjectWriteSource,
} from './binary-object-io';
import type { StorageVolumeAccess } from './volume-access';
import { IStorageProvider } from './interface';
import { NaidanOpfsStorageBackend } from './naidan-opfs/backend';
import { HostVolumeDB } from './opfs/host-volume-db';
import {
  createNativeOpfsFileSystemSession,
  unwrapNativeOpfsDirectoryHandle,
} from './storage-file-system/native-opfs';
import type { StorageFileSystemSession } from './storage-file-system/types';
import { OpfsStorageSessionLock } from './opfs/opfs-storage-session-lock';
import { isOpfsTransitionStorageBackend } from './opfs/opfs-transition-backend';
import {
  isOpfsSpecialFileSystemBackend,
  type OpfsSpecialFileSystemType,
} from './opfs/opfs-special-file-system';
import type { OpfsEncryptionInspection } from './opfs-encryption/bootstrap';
import type { OpfsEncryptionTransitionProgressListener } from './opfs-encryption/transition-progress';
import {
  createOpfsEncryptionDebugSession,
  type OpfsEncryptionDebugSession,
} from './opfs-encryption/inspection';
import type {
  EncryptionTransitionResult,
  UnlockedOpfsEncryptionSession,
} from './opfs-encryption/session';
import type {
  OpfsEncryptionWorkerRequest,
  OpfsEncryptionWorkerResult,
} from './opfs-encryption/worker/types';

const STORAGE_DIRECTORY_NAME = 'naidan-storage';
const ENCRYPTION_STATE_DIRECTORY_NAME = 'encryption-state';


function clearOpfsEncryptionWorkerRequestSecrets({
  request,
}: {
  request: OpfsEncryptionWorkerRequest;
}): void {
  switch (request.operation) {
  case 'disable':
  case 'reencrypt':
  case 'debug_interrupt_disable':
    request.storageUnlockKey.fill(0);
    return;
  case 'enable':
  case 'resume':
  case 'return_to_plain':
  case 'debug_interrupt_enable':
    // JavaScript strings cannot be zeroed. The Worker receives only the
    // passphrase string and never returns file payloads to the caller realm.
    return;
  default: {
    const _ex: never = request;
    throw new Error(`Unhandled transition Worker request: ${String(_ex)}`);
  }
  }
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error
      && (error.name === 'NotFoundError'
        || error.message.startsWith('NotFoundError'));
}

async function getStorageRootIfPresent(): Promise<FileSystemDirectoryHandle | undefined> {
  const opfsRoot = await navigator.storage.getDirectory();
  try {
    return await opfsRoot.getDirectoryHandle(STORAGE_DIRECTORY_NAME);
  } catch (error) {
    if (isNotFoundError({ error })) {
      return undefined;
    }
    throw error;
  }
}

async function getOrCreateStorageRoot(): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory();
  return await opfsRoot.getDirectoryHandle(STORAGE_DIRECTORY_NAME, { create: true });
}

async function hasEncryptionStateDirectory({
  storageRoot,
}: {
  storageRoot: FileSystemDirectoryHandle,
}): Promise<boolean> {
  try {
    await storageRoot.getDirectoryHandle(ENCRYPTION_STATE_DIRECTORY_NAME);
    return true;
  } catch (error) {
    if (isNotFoundError({ error })) {
      return false;
    }
    throw error;
  }
}

function exposeStorageVolumeAccess({ access }: {
  access: StorageVolumeAccess | null;
}): StorageVolumeAccess | null {
  if (access === null) {
    return null;
  }
  switch (access.type) {
  case 'storage_directory': {
    const nativeHandle = unwrapNativeOpfsDirectoryHandle({ handle: access.handle });
    return nativeHandle === undefined
      ? access
      : { type: 'direct_directory', handle: nativeHandle };
  }
  case 'direct_directory':
    return access;
  default: {
    const _ex: never = access;
    throw new Error(`Unhandled storage volume access: ${String(_ex)}`);
  }
  }
}

function requireEncryptedInspection({
  inspection,
}: {
  inspection: OpfsEncryptionInspection,
}): Extract<OpfsEncryptionInspection, { type: 'encrypted' }> {
  switch (inspection.type) {
  case 'encrypted':
    return inspection;
  case 'plain':
  case 'transitioning':
  case 'recovery_required':
    throw new Error(`OPFS storage cannot be unlocked from state: ${inspection.type}`);
  default: {
    const _ex: never = inspection;
    throw new Error(
      `Unhandled OPFS encryption inspection: ${((_ex satisfies never) as { readonly type: string }).type}`,
    );
  }
  }
}

function requirePlainInspection({
  inspection,
}: {
  inspection: OpfsEncryptionInspection,
}): void {
  switch (inspection.type) {
  case 'plain':
    return;
  case 'encrypted':
  case 'transitioning':
  case 'recovery_required':
    throw new Error(`OPFS encryption cannot be enabled from state: ${inspection.type}`);
  default: {
    const _ex: never = inspection;
    throw new Error(
      `Unhandled OPFS encryption inspection: ${((_ex satisfies never) as { readonly type: string }).type}`,
    );
  }
  }
}

function requireTransitioningInspection({
  inspection,
}: {
  inspection: OpfsEncryptionInspection,
}): Extract<OpfsEncryptionInspection, { type: 'transitioning' }> {
  switch (inspection.type) {
  case 'transitioning':
    return inspection;
  case 'plain':
  case 'encrypted':
  case 'recovery_required':
    throw new Error(`OPFS transition cannot be resumed from state: ${inspection.type}`);
  default: {
    const _ex: never = inspection;
    throw new Error(
      `Unhandled OPFS encryption inspection: ${((_ex satisfies never) as { readonly type: string }).type}`,
    );
  }
  }
}

/**
 * Public OPFS storage facade.
 *
 * Plain OPFS keeps the existing persistence format and implementation. The
 * encryption bootstrap and encrypted backend are loaded only when an
 * encryption-state directory exists or encryption-specific APIs are called.
 */
export class OPFSStorageProvider extends IStorageProvider {
  readonly canPersistBinary = true;

  private backend: IStorageProvider | undefined;
  private fileSystemSession: StorageFileSystemSession | undefined;
  private unlockedEncryptionSession: UnlockedOpfsEncryptionSession | undefined;
  private readonly hostVolumeDB = new HostVolumeDB();
  private readonly storageSessionLock = new OpfsStorageSessionLock();

  async init(): Promise<void> {
    await this.storageSessionLock.acquire();
    try {
      await this.storageSessionLock.run({ run: async () => {
        if (this.backend !== undefined) {
          await this.backend.init();
          return;
        }

        const storageRoot = await getStorageRootIfPresent();
        if (
          storageRoot === undefined
          || !(await hasEncryptionStateDirectory({ storageRoot }))
        ) {
          this.backend = await this.createPlainBackend();
          return;
        }

        const inspection = await this.inspectEncryption();
        switch (inspection.type) {
        case 'plain': {
          this.backend = await this.createPlainBackend();
          return;
        }
        case 'encrypted':
          throw new Error('OPFS encryption must be unlocked before storage can be used');
        case 'transitioning':
          throw new Error('OPFS encryption transition is in progress');
        case 'recovery_required':
          throw new Error('OPFS encryption state could not be read safely', { cause: inspection.error });
        default: {
          const _ex: never = inspection;
          throw new Error(`Unhandled OPFS encryption inspection: ${String(_ex)}`);
        }
        }
      } });
    } catch (error) {
      await this.storageSessionLock.suspend();
      throw error;
    }
  }

  async inspectEncryption(): Promise<OpfsEncryptionInspection> {
    const storageRoot = await getStorageRootIfPresent();
    if (storageRoot === undefined) {
      return { type: 'plain' };
    }
    const encryptionModule = await import('./opfs-encryption/bootstrap');
    return await encryptionModule.inspectOpfsEncryption({ storageRoot });
  }

  async unlockWithPassphrase({
    passphrase,
  }: {
    passphrase: string,
  }): Promise<void> {
    await this.storageSessionLock.acquire();
    try {
      await this.storageSessionLock.run({ run: async () => {
        const storageRoot = await getStorageRootIfPresent();
        if (storageRoot === undefined) {
          throw new Error('OPFS storage root does not exist');
        }
        const encryptionModule = await import('./opfs-encryption/bootstrap');
        const inspection = requireEncryptedInspection({
          inspection: await encryptionModule.inspectOpfsEncryption({ storageRoot }),
        });
        const session = await encryptionModule.unlockOpfsEncryptionWithPassphrase({
          storageRoot,
          state: inspection.state,
          passphrase,
        });
        await this.closeFileSystemSession();
        this.fileSystemSession = session.fileSystemSession;
        this.unlockedEncryptionSession = session;
        this.backend = session.backend;
      } });
    } catch (error) {
      await this.storageSessionLock.suspend();
      throw error;
    }
  }



  async createOpfsEncryptionDebugSession(): Promise<OpfsEncryptionDebugSession> {
    return await this.storageSessionLock.run({ run: async () => {
      const session = this.requireUnlockedEncryptionSession();
      const storageRoot = await getOrCreateStorageRoot();
      return await createOpfsEncryptionDebugSession({ storageRoot, session });
    } });
  }

  async lockEncryption(): Promise<void> {
    await this.storageSessionLock.suspend();
    this.clearEncryptionSession();
    await this.closeFileSystemSession();
    this.backend = undefined;
  }

  async suspendStorageSession(): Promise<void> {
    await this.storageSessionLock.suspend();
  }

  override async dispose(): Promise<void> {
    await this.storageSessionLock.suspend();
    this.clearEncryptionSession();
    await this.closeFileSystemSession();
    this.backend = undefined;
  }

  async enableEncryption({
    passphrase,
    signal,
    onProgress,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
    onProgress?: OpfsEncryptionTransitionProgressListener,
  }): Promise<void> {
    const inspection = await this.inspectEncryption();
    requirePlainInspection({ inspection });
    const storageRoot = await getOrCreateStorageRoot();
    await this.runTransitionInWorker({
      request: {
        operation: 'enable',
        storageRoot,
        nativeNamespaceRoot: await navigator.storage.getDirectory(),
        passphrase,
      },
      signal,
      onProgress,
      reopen: { type: 'passphrase', passphrase },
    });
  }

  async changePassphrase({
    passphrase,
  }: {
    passphrase: string,
  }): Promise<void> {
    await this.storageSessionLock.run({ run: async () => {
      const session = this.requireUnlockedEncryptionSession();
      const storageRoot = await getOrCreateStorageRoot();
      const keyManager = await import('./opfs-encryption/encryption-key-manager');
      const stateModule = await import('./opfs-encryption/encryption-state-store');
      if (typeof navigator === 'undefined' || navigator.locks?.request === undefined) {
        throw new Error('Changing the OPFS encryption passphrase requires the Web Locks API');
      }
      await navigator.locks.request(
        'naidan:sync:lock:opfs_encryption_state_update',
        { mode: 'exclusive' },
        async () => {
          const stateStore = new stateModule.EncryptionStateStore({ storageRoot });
          const inspection = await stateStore.inspect();
          if (inspection.type !== 'encrypted' || inspection.state.state !== 'encrypted') {
            throw new Error('Encrypted storage state changed in another tab');
          }
          if (inspection.state.activeEncryptedStoreId !== session.state.activeEncryptedStoreId) {
            throw new Error('Active encrypted store changed in another tab');
          }
          const state = {
            ...inspection.state,
            sequence: inspection.state.sequence + 1,
            keySlots: await keyManager.replacePassphraseEncryptionKeySlot({
              storageUnlockKey: session.storageUnlockKey,
              keySlots: inspection.state.keySlots,
              keySlotId: session.unlockedKeySlotId,
              passphrase,
              pbkdf2Iterations: keyManager.DEFAULT_PBKDF2_ITERATIONS,
            }),
          };
          await stateStore.writeState({ state });
          this.unlockedEncryptionSession = {
            ...session,
            state,
          };
        },
      );
    } });
  }

  async disableEncryption({
    signal,
    onProgress,
  }: {
    signal: AbortSignal | undefined,
    onProgress?: OpfsEncryptionTransitionProgressListener,
  }): Promise<void> {
    const session = this.requireUnlockedEncryptionSession();
    const storageRoot = await getOrCreateStorageRoot();
    await this.runTransitionInWorker({
      request: {
        operation: 'disable',
        storageRoot,
        nativeNamespaceRoot: await navigator.storage.getDirectory(),
        state: session.state,
        storageUnlockKey: session.storageUnlockKey.slice(),
        unlockedKeySlotId: session.unlockedKeySlotId,
      },
      signal,
      onProgress,
      reopen: { type: 'plain' },
    });
  }

  async reencrypt({
    signal,
    onProgress,
  }: {
    signal: AbortSignal | undefined,
    onProgress?: OpfsEncryptionTransitionProgressListener,
  }): Promise<void> {
    const session = this.requireUnlockedEncryptionSession();
    const storageRoot = await getOrCreateStorageRoot();
    await this.runTransitionInWorker({
      request: {
        operation: 'reencrypt',
        storageRoot,
        nativeNamespaceRoot: await navigator.storage.getDirectory(),
        state: session.state,
        storageUnlockKey: session.storageUnlockKey.slice(),
        unlockedKeySlotId: session.unlockedKeySlotId,
      },
      signal,
      onProgress,
      reopen: {
        type: 'unlocked_key',
        storageUnlockKey: session.storageUnlockKey,
        unlockedKeySlotId: session.unlockedKeySlotId,
      },
    });
  }

  async resumeTransitionWithPassphrase({
    passphrase,
    signal,
    onProgress,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
    onProgress?: OpfsEncryptionTransitionProgressListener,
  }): Promise<void> {
    const inspection = requireTransitioningInspection({
      inspection: await this.inspectEncryption(),
    });
    const storageRoot = await getOrCreateStorageRoot();
    await this.runTransitionInWorker({
      request: {
        operation: 'resume',
        storageRoot,
        nativeNamespaceRoot: await navigator.storage.getDirectory(),
        state: inspection.state,
        passphrase,
      },
      signal,
      onProgress,
      reopen: { type: 'passphrase', passphrase },
    });
  }

  async returnInterruptedEncryptionToPlain({
    passphrase,
    signal,
    onProgress,
  }: {
    passphrase: string | undefined,
    signal: AbortSignal | undefined,
    onProgress?: OpfsEncryptionTransitionProgressListener,
  }): Promise<void> {
    const inspection = requireTransitioningInspection({
      inspection: await this.inspectEncryption(),
    });
    switch (inspection.operation.type) {
    case 'encrypting':
      break;
    case 'decrypting':
    case 'reencrypting':
      throw new Error('Only interrupted OPFS encryption can return directly to plain storage');
    default: {
      const _ex: never = inspection.operation;
      throw new Error(`Unhandled OPFS encryption operation: ${((_ex satisfies never) as { readonly type: string }).type}`);
    }
    }
    const storageRoot = await getOrCreateStorageRoot();
    await this.runTransitionInWorker({
      request: {
        operation: 'return_to_plain',
        storageRoot,
        nativeNamespaceRoot: await navigator.storage.getDirectory(),
        state: inspection.state,
        passphrase,
      },
      signal,
      onProgress,
      reopen: { type: 'plain' },
    });
  }

  async createInterruptedEncryptionForDebug({
    passphrase,
    signal,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    const storageRoot = await getOrCreateStorageRoot();
    await this.runInterruptedTransitionInWorker({
      request: {
        operation: 'debug_interrupt_enable',
        storageRoot,
        nativeNamespaceRoot: await navigator.storage.getDirectory(),
        passphrase,
      },
      signal,
    });
  }

  async createInterruptedDecryptionForDebug({
    signal,
  }: {
    signal: AbortSignal | undefined,
  }): Promise<void> {
    const session = this.requireUnlockedEncryptionSession();
    const storageRoot = await getOrCreateStorageRoot();
    await this.runInterruptedTransitionInWorker({
      request: {
        operation: 'debug_interrupt_disable',
        storageRoot,
        nativeNamespaceRoot: await navigator.storage.getDirectory(),
        state: session.state,
        storageUnlockKey: session.storageUnlockKey.slice(),
        unlockedKeySlotId: session.unlockedKeySlotId,
      },
      signal,
    });
  }

  async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.listChatMetasRaw() });
  }

  async listChatGroupsRaw(): Promise<ChatGroupDto[]> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.listChatGroupsRaw() });
  }

  async loadHierarchy(): Promise<HierarchyDto | null> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.loadHierarchy() });
  }

  async saveHierarchy({ hierarchy }: { hierarchy: HierarchyDto }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.saveHierarchy({ hierarchy }) });
  }

  async dump(): Promise<StorageSnapshot> {
    const snapshot = await this.runWithBackend({ run: async ({ backend }) => await backend.dump() });
    return {
      structure: snapshot.structure,
      contentStream: this.storageSessionLock.iterate({
        createSource: () => snapshot.contentStream,
      }),
    };
  }

  async restore({ snapshot }: { snapshot: StorageSnapshot }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.restore({ snapshot }) });
  }

  async getSidebarStructure(): Promise<SidebarItem[]> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.getSidebarStructure() });
  }

  async saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.saveChatMeta({ meta }) });
  }

  async saveChatContent({
    id,
    content,
  }: {
    id: ChatId,
    content: ChatContent,
  }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.saveChatContent({ id, content }) });
  }

  async loadChat({ id }: { id: ChatId }): Promise<Chat | null> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.loadChat({ id }) });
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.loadChatMeta({ id }) });
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.loadChatContent({ id }) });
  }

  async loadChatContentWithoutAttachments({
    id,
  }: {
    id: ChatId,
  }): Promise<ChatContent | null> {
    return await this.runWithBackend({
      run: async ({ backend }) => await backend.loadChatContentWithoutAttachments({ id }),
    });
  }

  async deleteChat({ id }: { id: ChatId }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.deleteChat({ id }) });
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.saveChatGroup({ chatGroup }) });
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.loadChatGroup({ id }) });
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.deleteChatGroup({ id }) });
  }

  async saveSettings({ settings }: { settings: Settings }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.saveSettings({ settings }) });
  }

  async loadSettings(): Promise<Settings | null> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.loadSettings() });
  }

  async clearAll(): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.clearAll() });
  }

  async writeBinaryObject({
    source,
    binaryObjectId,
    name,
    mimeType,
    size,
    createdAt,
    signal,
  }: {
    source: StorageBinaryObjectWriteSource,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType: string,
    size: number,
    createdAt: number,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.writeBinaryObject({
      source,
      binaryObjectId,
      name,
      mimeType,
      size,
      createdAt,
      signal,
    }) });
  }

  async openBinaryObject({
    binaryObjectId,
  }: {
    binaryObjectId: BinaryObjectId,
  }): Promise<StorageBinaryObjectReadHandle | null> {
    const release = this.storageSessionLock.acquireOperation();
    try {
      const handle = await this.requireBackend().openBinaryObject({ binaryObjectId });
      if (handle === null) {
        release();
        return null;
      }
      return this.wrapBinaryObjectReadHandle({ handle, release });
    } catch (error) {
      release();
      throw error;
    }
  }

  async getBinaryObject({
    binaryObjectId,
  }: {
    binaryObjectId: BinaryObjectId,
  }): Promise<BinaryObject | null> {
    return await this.runWithBackend({
      run: async ({ backend }) => await backend.getBinaryObject({ binaryObjectId }),
    });
  }

  async hasAttachments(): Promise<boolean> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.hasAttachments() });
  }

  async *listBinaryObjects(): AsyncIterable<BinaryObject> {
    yield* this.iterateWithBackend({
      createSource: ({ backend }) => backend.listBinaryObjects(),
    });
  }

  async deleteBinaryObject({
    binaryObjectId,
  }: {
    binaryObjectId: BinaryObjectId,
  }): Promise<void> {
    await this.runWithBackend({
      run: async ({ backend }) => await backend.deleteBinaryObject({ binaryObjectId }),
    });
  }

  async *listVolumes(): AsyncIterable<Volume> {
    yield* this.iterateWithBackend({ createSource: ({ backend }) => backend.listVolumes() });
  }

  async createVolume({
    name,
    type,
    sourceHandle,
  }: {
    name: string,
    type: VolumeType,
    sourceHandle: FileSystemDirectoryHandle,
  }): Promise<Volume> {
    return await this.runWithBackend({
      run: async ({ backend }) => await backend.createVolume({ name, type, sourceHandle }),
    });
  }

  async createVolumeFromFiles({
    name,
    entries,
    onProgress,
    signal,
  }: {
    name: string,
    entries: Array<{ file: File, relativePath: string }>,
    onProgress?: ({ processed, total }: { processed: number, total: number }) => void,
    signal?: AbortSignal,
  }): Promise<Volume> {
    return await this.runWithBackend({ run: async ({ backend }) => await backend.createVolumeFromFiles({
      name,
      entries,
      onProgress,
      signal,
    }) });
  }

  async openVolume({
    volumeId,
  }: {
    volumeId: VolumeId,
  }): Promise<StorageVolumeAccess | null> {
    return await this.runWithBackend({
      run: async ({ backend }) => exposeStorageVolumeAccess({
        access: await backend.openVolume({ volumeId }),
      }),
    });
  }

  async openSpecialFileSystemDirectory({
    type,
    path,
    create,
  }: {
    type: OpfsSpecialFileSystemType,
    path: string,
    create: boolean,
  }): Promise<StorageVolumeAccess | null> {
    return await this.runWithBackend({ run: async ({ backend }) => {
      if (!isOpfsSpecialFileSystemBackend(backend)) {
        throw new Error('Active OPFS backend does not support special filesystems');
      }
      return exposeStorageVolumeAccess({
        access: await backend.openSpecialFileSystemDirectory({ type, path, create }),
      });
    } });
  }

  async removeSpecialFileSystemEntry({
    type,
    path,
    recursive,
  }: {
    type: OpfsSpecialFileSystemType,
    path: string,
    recursive: boolean,
  }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => {
      if (!isOpfsSpecialFileSystemBackend(backend)) {
        throw new Error('Active OPFS backend does not support special filesystems');
      }
      await backend.removeSpecialFileSystemEntry({ type, path, recursive });
    } });
  }

  async clearSpecialFileSystem({
    type,
  }: {
    type: OpfsSpecialFileSystemType,
  }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => {
      if (!isOpfsTransitionStorageBackend(backend)) {
        throw new Error('Active OPFS backend cannot clear special filesystems');
      }
      await backend.removeSpecialFileSystemForTransition({ type });
    } });
  }

  async deleteVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.deleteVolume({ volumeId }) });
  }

  async renameVolume({
    volumeId,
    name,
  }: {
    volumeId: VolumeId,
    name: string,
  }): Promise<void> {
    await this.runWithBackend({ run: async ({ backend }) => await backend.renameVolume({ volumeId, name }) });
  }

  private async runTransitionInWorker({
    request,
    signal,
    onProgress,
    reopen,
  }: {
    request: OpfsEncryptionWorkerRequest;
    signal: AbortSignal | undefined;
    onProgress: OpfsEncryptionTransitionProgressListener | undefined;
    reopen:
      | { readonly type: 'plain' }
      | { readonly type: 'passphrase'; readonly passphrase: string }
      | {
          readonly type: 'unlocked_key';
          readonly storageUnlockKey: Uint8Array;
          readonly unlockedKeySlotId: string;
        };
  }): Promise<void> {
    try {
      await this.storageSessionLock.suspend();
      try {
        if (__BUILD_TARGET_IS_FILE_PROTOCOL_STANDALONE_WORKER__) {
          // The standalone hub already owns the OPFS encryption Worker service.
          // Provider copies pulled into another hub service must not recursively
          // create the same hub or emit a nested Worker asset.
          throw new Error('OPFS encryption transitions cannot be initiated from the standalone Worker Hub');
        }
        const workerModule = await import(
          '@/00-storage/service/opfs-encryption/worker/client'
        );
        const worker = await workerModule.createOpfsEncryptionWorkerClient();
        let result: OpfsEncryptionWorkerResult;
        try {
          result = await worker.run({ request, signal, onProgress });
        } finally {
          await worker.dispose();
        }
        await this.applyWorkerTransitionResult({ result, reopen });
        await this.storageSessionLock.acquire();
      } catch (error) {
        try {
          await this.recoverAfterFailedTransition();
        } catch (recoveryError) {
          console.error(
            'Failed to restore OPFS provider after encryption transition failure:',
            recoveryError,
          );
        }
        throw error;
      }
    } finally {
      clearOpfsEncryptionWorkerRequestSecrets({ request });
    }
  }

  private async runInterruptedTransitionInWorker({
    request,
    signal,
  }: {
    request: OpfsEncryptionWorkerRequest;
    signal: AbortSignal | undefined;
  }): Promise<void> {
    try {
      await this.storageSessionLock.suspend();
      if (__BUILD_TARGET_IS_FILE_PROTOCOL_STANDALONE_WORKER__) {
        throw new Error('Interrupted OPFS transitions cannot be created from the standalone Worker Hub');
      }
      const workerModule = await import(
        '@/00-storage/service/opfs-encryption/worker/client'
      );
      const worker = await workerModule.createOpfsEncryptionWorkerClient();
      let result: OpfsEncryptionWorkerResult;
      try {
        result = await worker.run({
          request,
          signal,
          onProgress: undefined,
        });
      } finally {
        await worker.dispose();
      }
      switch (result.type) {
      case 'interrupted':
        break;
      case 'plain':
      case 'encrypted':
        throw new Error(`Expected interrupted transition state, received: ${result.type}`);
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled OPFS encryption Worker result: ${((_ex satisfies never) as { readonly type: string }).type}`);
      }
      }
      this.clearEncryptionSession();
      await this.closeFileSystemSession();
      this.backend = undefined;
    } catch (error) {
      try {
        await this.recoverAfterFailedTransition();
      } catch (recoveryError) {
        console.error('Failed to restore OPFS provider after interrupted transition setup failure:', recoveryError);
      }
      throw error;
    } finally {
      clearOpfsEncryptionWorkerRequestSecrets({ request });
    }
  }

  private async applyWorkerTransitionResult({
    result,
    reopen,
  }: {
    result: OpfsEncryptionWorkerResult;
    reopen:
      | { readonly type: 'plain' }
      | { readonly type: 'passphrase'; readonly passphrase: string }
      | {
          readonly type: 'unlocked_key';
          readonly storageUnlockKey: Uint8Array;
          readonly unlockedKeySlotId: string;
        };
  }): Promise<void> {
    switch (result.type) {
    case 'plain': {
      switch (reopen.type) {
      case 'plain':
        break;
      case 'passphrase':
      case 'unlocked_key':
        throw new Error('OPFS encryption Worker returned plain storage unexpectedly');
      default: {
        const _ex: never = reopen;
        throw new Error(`Unhandled transition reopen strategy: ${String(_ex)}`);
      }
      }
      this.clearEncryptionSession();
      this.backend = await this.createPlainBackend();
      return;
    }
    case 'interrupted':
      throw new Error('Interrupted transition result cannot be installed as a stable backend');
    case 'encrypted': {
      const storageRoot = await getOrCreateStorageRoot();
      const encryptionModule = await import('./opfs-encryption/bootstrap');
      const inspection = requireEncryptedInspection({
        inspection: await encryptionModule.inspectOpfsEncryption({ storageRoot }),
      });
      const nextSession = await (async () => {
        switch (reopen.type) {
        case 'plain':
          throw new Error('OPFS encryption Worker returned encrypted storage unexpectedly');
        case 'passphrase':
          return await encryptionModule.unlockOpfsEncryptionWithPassphrase({
            storageRoot,
            state: inspection.state,
            passphrase: reopen.passphrase,
          });
        case 'unlocked_key':
          return await encryptionModule.createUnlockedOpfsEncryptionSession({
            storageRoot,
            state: inspection.state,
            storageUnlockKey: reopen.storageUnlockKey,
            unlockedKeySlotId: reopen.unlockedKeySlotId,
          });
        default: {
          const _ex: never = reopen;
          throw new Error(`Unhandled transition reopen strategy: ${String(_ex)}`);
        }
        }
      })();
      await this.applyTransitionResult({
        result: { type: 'encrypted', session: nextSession },
      });
      return;
    }
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled transition Worker result: ${String(_ex)}`);
    }
    }
  }

  private async recoverAfterFailedTransition(): Promise<void> {
    const previousSession = this.unlockedEncryptionSession;
    const inspection = await this.inspectEncryption();
    switch (inspection.type) {
    case 'plain': {
      this.clearEncryptionSession();
      await this.storageSessionLock.acquire();
      try {
        this.backend = await this.storageSessionLock.run({
          run: async () => await this.createPlainBackend(),
        });
      } catch (error) {
        await this.storageSessionLock.suspend();
        throw error;
      }
      return;
    }
    case 'encrypted':
      if (
        previousSession !== undefined
        && previousSession.state.activeEncryptedStoreId
          === inspection.state.activeEncryptedStoreId
      ) {
        this.backend = previousSession.backend;
        await this.storageSessionLock.acquire();
        return;
      }
      this.clearEncryptionSession();
      this.backend = undefined;
      return;
    case 'transitioning':
    case 'recovery_required':
      this.clearEncryptionSession();
      this.backend = undefined;
      return;
    default: {
      const _ex: never = inspection;
      throw new Error(`Unhandled OPFS encryption inspection: ${String(_ex)}`);
    }
    }
  }

  private async applyTransitionResult({
    result,
  }: {
    result: EncryptionTransitionResult,
  }): Promise<void> {
    const previousEncryptionSession = this.unlockedEncryptionSession;
    const previousFileSystemSession = this.fileSystemSession;
    const nextFileSystemSession = (() => {
      switch (result.type) {
      case 'encrypted':
        return result.session.fileSystemSession;
      case 'plain':
        return result.fileSystemSession;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled encryption transition result: ${String(_ex)}`);
      }
      }
    })();

    switch (result.type) {
    case 'encrypted':
      if (
        previousEncryptionSession !== undefined
        && previousEncryptionSession.storageUnlockKey !== result.session.storageUnlockKey
      ) {
        previousEncryptionSession.storageUnlockKey.fill(0);
      }
      this.unlockedEncryptionSession = result.session;
      this.backend = result.session.backend;
      break;
    case 'plain':
      previousEncryptionSession?.storageUnlockKey.fill(0);
      this.unlockedEncryptionSession = undefined;
      this.backend = result.backend;
      break;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled OPFS transition result: ${String(_ex)}`);
    }
    }

    this.fileSystemSession = nextFileSystemSession;
    if (
      previousFileSystemSession !== undefined
      && previousFileSystemSession !== nextFileSystemSession
    ) {
      await previousFileSystemSession.close();
    }
  }

  private async createPlainBackend(): Promise<NaidanOpfsStorageBackend> {
    const nextSession = createNativeOpfsFileSystemSession({
      root: await navigator.storage.getDirectory(),
    });
    const backend = new NaidanOpfsStorageBackend({
      namespaceRoot: nextSession.root,
      hostVolumeDB: this.hostVolumeDB,
    });
    try {
      await backend.init();
    } catch (error) {
      await nextSession.close();
      throw error;
    }
    await this.closeFileSystemSession();
    this.fileSystemSession = nextSession;
    return backend;
  }

  private async closeFileSystemSession(): Promise<void> {
    const session = this.fileSystemSession;
    this.fileSystemSession = undefined;
    await session?.close();
  }

  private clearEncryptionSession(): void {
    this.unlockedEncryptionSession?.storageUnlockKey.fill(0);
    this.unlockedEncryptionSession = undefined;
  }

  private async runWithBackend<T>({
    run,
  }: {
    run: ({ backend }: { backend: IStorageProvider }) => Promise<T>,
  }): Promise<T> {
    return await this.storageSessionLock.run({
      run: async () => await run({ backend: this.requireBackend() }),
    });
  }

  private iterateWithBackend<T>({
    createSource,
  }: {
    createSource: ({ backend }: { backend: IStorageProvider }) => AsyncIterable<T>,
  }): AsyncGenerator<T> {
    return this.storageSessionLock.iterate({
      createSource: () => createSource({ backend: this.requireBackend() }),
    });
  }

  private wrapBinaryObjectReadHandle({
    handle,
    release,
  }: {
    handle: StorageBinaryObjectReadHandle,
    release: () => void,
  }): StorageBinaryObjectReadHandle {
    let closed = false;
    return {
      size: handle.size,
      mimeType: handle.mimeType,
      backing: handle.backing,
      async read({ buffer, offset, length, position, signal }) {
        return await handle.read({ buffer, offset, length, position, signal });
      },
      stream({ start, end, signal }) {
        return handle.stream({ start, end, signal });
      },
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        try {
          await handle.close();
        } finally {
          release();
        }
      },
    };
  }

  private requireUnlockedEncryptionSession(): UnlockedOpfsEncryptionSession {
    if (this.unlockedEncryptionSession === undefined) {
      throw new Error('OPFS encryption is not unlocked');
    }
    return this.unlockedEncryptionSession;
  }

  private requireBackend(): IStorageProvider {
    if (this.backend === undefined) {
      throw new Error('OPFS storage provider has not been initialized or unlocked');
    }
    return this.backend;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  clearOpfsEncryptionWorkerRequestSecrets,
  getOrCreateStorageRoot,
  getStorageRootIfPresent,
  hasEncryptionStateDirectory,
};
