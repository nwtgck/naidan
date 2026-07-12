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
  StorageBinaryObjectWriteSource,
} from '@/00-storage/00-dto/dto';
import type { StorageBinaryObjectReadHandle } from './binary-object-io';
import type { StorageVolumeAccess } from './volume-access';
import { IStorageProvider } from './interface';
import { PlainOPFSStorageBackend } from './opfs/plain-opfs-storage-backend';
import { OpfsStorageSessionLock } from './opfs/opfs-storage-session-lock';
import { isOpfsTransitionStorageBackend } from './opfs/opfs-transition-backend';
import {
  isOpfsSpecialFileSystemBackend,
  type OpfsSpecialFileSystemType,
} from './opfs/opfs-special-file-system';
import type { OpfsEncryptionInspection } from './opfs-encryption/bootstrap';
import type { EncryptedStorageDebugCapability } from './opfs-encryption/encrypted-storage-debug-capability';
import type {
  EncryptionTransitionResult,
  UnlockedOpfsEncryptionSession,
} from './opfs-encryption/encryption-transition-coordinator';

const STORAGE_DIRECTORY_NAME = 'naidan-storage';
const ENCRYPTION_STATE_DIRECTORY_NAME = 'encryption-state';

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
  private unlockedEncryptionSession: UnlockedOpfsEncryptionSession | undefined;
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
          const backend = new PlainOPFSStorageBackend();
          await backend.init();
          this.backend = backend;
          return;
        }

        const inspection = await this.inspectEncryption();
        switch (inspection.type) {
        case 'plain': {
          const backend = new PlainOPFSStorageBackend();
          await backend.init();
          this.backend = backend;
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
        this.unlockedEncryptionSession = session;
        this.backend = session.backend;
      } });
    } catch (error) {
      await this.storageSessionLock.suspend();
      throw error;
    }
  }



  async createEncryptedStorageDebugCapability(): Promise<EncryptedStorageDebugCapability> {
    return await this.storageSessionLock.run({ run: async () => {
      const session = this.requireUnlockedEncryptionSession();
      const storageRoot = await getOrCreateStorageRoot();
      return session.backend.createDebugCapability({ storageRoot });
    } });
  }

  async lockEncryption(): Promise<void> {
    await this.storageSessionLock.suspend();
    this.clearEncryptionSession();
    this.backend = undefined;
  }

  async suspendStorageSession(): Promise<void> {
    await this.storageSessionLock.suspend();
  }

  override async dispose(): Promise<void> {
    await this.storageSessionLock.suspend();
    this.clearEncryptionSession();
    this.backend = undefined;
  }

  async enableEncryption({
    passphrase,
    signal,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    const result = await this.runTransition({ run: async () => {
      const inspection = await this.inspectEncryption();
      requirePlainInspection({ inspection });
      const storageRoot = await getOrCreateStorageRoot();
      const transitionModule = await import(
        './opfs-encryption/encryption-transition-coordinator'
      );
      return await new transitionModule.EncryptionTransitionCoordinator({
        storageRoot,
      }).enableEncryption({ passphrase, signal });
    } });
    switch (result.type) {
    case 'encrypted':
      return;
    case 'plain':
      throw new Error('Enabling OPFS encryption produced a plain storage backend');
    default: {
      const _ex: never = result;
      throw new Error(
        `Unhandled encryption transition result: ${((_ex satisfies never) as { readonly type: string }).type}`,
      );
    }
    }
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
  }: {
    signal: AbortSignal | undefined,
  }): Promise<void> {
    const session = this.requireUnlockedEncryptionSession();
    await this.runTransition({ run: async () => {
      const storageRoot = await getOrCreateStorageRoot();
      const transitionModule = await import(
        './opfs-encryption/encryption-transition-coordinator'
      );
      return await new transitionModule.EncryptionTransitionCoordinator({
        storageRoot,
      }).disableEncryption({ session, signal });
    } });
  }

  async reencrypt({
    signal,
  }: {
    signal: AbortSignal | undefined,
  }): Promise<void> {
    const session = this.requireUnlockedEncryptionSession();
    await this.runTransition({ run: async () => {
      const storageRoot = await getOrCreateStorageRoot();
      const transitionModule = await import(
        './opfs-encryption/encryption-transition-coordinator'
      );
      return await new transitionModule.EncryptionTransitionCoordinator({
        storageRoot,
      }).reencrypt({ session, signal });
    } });
  }

  async resumeTransitionWithPassphrase({
    passphrase,
    signal,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    await this.runTransition({ run: async () => {
      const inspection = requireTransitioningInspection({
        inspection: await this.inspectEncryption(),
      });
      const storageRoot = await getOrCreateStorageRoot();
      const transitionModule = await import(
        './opfs-encryption/encryption-transition-coordinator'
      );
      return await new transitionModule.EncryptionTransitionCoordinator({
        storageRoot,
      }).resumeWithPassphrase({ state: inspection.state, passphrase, signal });
    } });
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
    return await this.runWithBackend({ run: async ({ backend }) => await backend.openVolume({ volumeId }) });
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
      return await backend.openSpecialFileSystemDirectory({ type, path, create });
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

  private async runTransition({
    run,
  }: {
    run: () => Promise<EncryptionTransitionResult>,
  }): Promise<EncryptionTransitionResult> {
    await this.storageSessionLock.suspend();
    try {
      const result = await run();
      this.applyTransitionResult({ result });
      await this.storageSessionLock.acquire();
      return result;
    } catch (error) {
      try {
        await this.recoverAfterFailedTransition();
      } catch (recoveryError) {
        console.error('Failed to restore OPFS provider after encryption transition failure:', recoveryError);
      }
      throw error;
    }
  }

  private async recoverAfterFailedTransition(): Promise<void> {
    const previousSession = this.unlockedEncryptionSession;
    const inspection = await this.inspectEncryption();
    switch (inspection.type) {
    case 'plain': {
      this.clearEncryptionSession();
      const backend = new PlainOPFSStorageBackend();
      await this.storageSessionLock.acquire();
      try {
        await this.storageSessionLock.run({ run: async () => await backend.init() });
      } catch (error) {
        await this.storageSessionLock.suspend();
        throw error;
      }
      this.backend = backend;
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

  private applyTransitionResult({
    result,
  }: {
    result: EncryptionTransitionResult,
  }): void {
    const previousSession = this.unlockedEncryptionSession;
    switch (result.type) {
    case 'encrypted':
      if (
        previousSession !== undefined
        && previousSession.storageUnlockKey !== result.session.storageUnlockKey
      ) {
        previousSession.storageUnlockKey.fill(0);
      }
      this.unlockedEncryptionSession = result.session;
      this.backend = result.session.backend;
      break;
    case 'plain':
      previousSession?.storageUnlockKey.fill(0);
      this.unlockedEncryptionSession = undefined;
      this.backend = result.backend;
      break;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled OPFS transition result: ${String(_ex)}`);
    }
    }
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
  getOrCreateStorageRoot,
  getStorageRootIfPresent,
  hasEncryptionStateDirectory,
};
