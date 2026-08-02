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
import {
  OpfsPlainNamespaceSessionLock,
  OpfsStorageSessionLock,
  runWithExclusiveOpfsStorageSessionFence,
} from './opfs/opfs-storage-session-lock';
import { isOpfsTransitionStorageBackend } from './opfs/opfs-transition-backend';
import {
  isOpfsSpecialFileSystemBackend,
  type OpfsSpecialFileSystemType,
} from './opfs/opfs-special-file-system';
import type {
  OpfsEncryptionInspection,
  OpfsEncryptionSettingsInspection,
  OpfsPersistenceRuntime,
  OpfsPersistenceTransitionRequest,
  OpfsPersistenceUnlockedSession,
} from './naidan-opfs/persistence-runtime-contract';
import { createInstalledOpfsPersistenceRuntime } from './naidan-opfs/persistence-runtime-registry';
import { NAIDAN_OPFS_STORAGE_DIRECTORY_NAME } from './naidan-opfs/opfs-storage-location';
import { reportHizoFSTrialDebug } from './naidan-opfs/trial-debug';
import { installActiveAuthenticatedHizoFSContainerLocation } from './naidan-opfs/active-hizofs-container-location';
import type { OpfsEncryptionTransitionProgressListener } from './naidan-opfs/transition-progress';
import { NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS } from './naidan-persistence-control/00-format';

const PERSISTENCE_CONTROL_DIRECTORY_NAME =
  NAIDAN_PERSISTENCE_CONTROL_FORMAT_CONSTANTS.storage.collectionDirectoryName;

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
    return await opfsRoot.getDirectoryHandle(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME);
  } catch (error) {
    if (isNotFoundError({ error })) {
      return undefined;
    }
    throw error;
  }
}

async function getOrCreateStorageRoot(): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory();
  return await opfsRoot.getDirectoryHandle(NAIDAN_OPFS_STORAGE_DIRECTORY_NAME, { create: true });
}

async function hasPersistenceControlDirectory({
  storageRoot,
}: {
  storageRoot: FileSystemDirectoryHandle,
}): Promise<boolean> {
  try {
    await storageRoot.getDirectoryHandle(PERSISTENCE_CONTROL_DIRECTORY_NAME);
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

function projectEncryptionSettingsInspection({
  inspection,
  unlockedSession,
}: {
  inspection: OpfsEncryptionInspection;
  unlockedSession: OpfsPersistenceUnlockedSession | undefined;
}): OpfsEncryptionSettingsInspection {
  switch (inspection.type) {
  case 'plain':
    return unlockedSession === undefined
      ? { type: 'plain' }
      : {
        error: new Error('Plain Persistence Control authority conflicts with an installed HizoFS session'),
        type: 'recovery_required',
      };
  case 'credential_required':
    return unlockedSession === undefined
      ? { access: 'locked', type: 'encrypted' }
      : { access: 'unlocked', fileSystemId: unlockedSession.fileSystemId, type: 'encrypted' };
  case 'encrypted':
    if (unlockedSession === undefined) {
      return { access: 'locked', type: 'encrypted' };
    }
    if (unlockedSession.fileSystemId !== inspection.mode.activeFileSystemId) {
      return {
        error: new Error('Authenticated HizoFS session does not match the selected Persistence Control authority'),
        type: 'recovery_required',
      };
    }
    return { access: 'unlocked', fileSystemId: unlockedSession.fileSystemId, type: 'encrypted' };
  case 'transitioning':
    return { inspection, type: 'transitioning' };
  case 'recovery_required':
    return inspection;
  default: {
    const _ex: never = inspection;
    throw new Error(`Unhandled OPFS encryption inspection: ${String(_ex)}`);
  }
  }
}

function requireUnlockableInspection({
  inspection,
}: {
  inspection: OpfsEncryptionInspection,
}): Extract<OpfsEncryptionInspection, { type: 'credential_required' | 'encrypted' }> {
  switch (inspection.type) {
  case 'credential_required':
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
  case 'credential_required':
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

function requireReturnToPlainInspection({
  inspection,
}: {
  inspection: OpfsEncryptionInspection,
}): void {
  switch (inspection.type) {
  case 'credential_required':
    switch (inspection.requiredAction) {
    case 'converge_transition': return;
    case 'unlock': throw new Error('Stable encrypted OPFS storage cannot return through interrupted encryption recovery');
    default: inspection.requiredAction satisfies never;
    }
    return;
  case 'transitioning':
    switch (inspection.mode.operation) {
    case 'encrypt': return;
    case 'decrypt':
    case 're_encrypt': throw new Error('Only interrupted OPFS encryption can return directly to plain storage');
    default: inspection.mode.operation satisfies never;
    }
    return;
  case 'plain':
  case 'encrypted':
  case 'recovery_required':
    throw new Error(`Interrupted OPFS encryption cannot return to plain from state: ${inspection.type}`);
  default: {
    const _ex: never = inspection;
    throw new Error(
      `Unhandled OPFS encryption inspection: ${((_ex satisfies never) as { readonly type: string }).type}`,
    );
  }
  }
}

async function closePlainSessionAfterBackendInitializationFailure({ cause, fileSystemSession }: {
  cause: unknown;
  fileSystemSession: Pick<StorageFileSystemSession, 'close'>;
}): Promise<never> {
  try {
    await fileSystemSession.close();
  } catch (cleanupFailure: unknown) {
    throw new AggregateError(
      [cause, cleanupFailure],
      'plain OPFS backend initialization and session cleanup both failed',
    );
  }
  throw cause;
}

async function closePersistenceSessionAfterInstallFailure({ cause, session }: {
  cause: unknown;
  session: Pick<OpfsPersistenceUnlockedSession, 'close'>;
}): Promise<never> {
  try {
    await session.close();
  } catch (cleanupFailure: unknown) {
    throw new AggregateError(
      [cause, cleanupFailure],
      'authenticated OPFS session installation and candidate cleanup both failed',
    );
  }
  throw cause;
}

async function suspendStorageSessionAfterFailure({ cause, message, suspend }: {
  cause: unknown;
  message: string;
  suspend: () => Promise<void>;
}): Promise<never> {
  try {
    await suspend();
  } catch (suspensionFailure: unknown) {
    throw new AggregateError([cause, suspensionFailure], message);
  }
  throw cause;
}

async function settleProviderAfterTransitionFailure({ cause, message, settle }: {
  cause: unknown;
  message: string;
  settle: () => Promise<void>;
}): Promise<never> {
  try {
    await settle();
  } catch (settlementFailure: unknown) {
    throw new AggregateError([cause, settlementFailure], message);
  }
  throw cause;
}

async function settleProviderForReloadAfterTransition({
  settleProvider,
}: {
  settleProvider: () => Promise<void>;
}): Promise<void> {
  await settleProvider();
}

async function settleStorageProviderShutdown({
  clearBackend,
  clearFileSystemSession,
  clearPersistenceSession,
  message,
  suspend,
}: {
  clearBackend: () => void;
  clearFileSystemSession: () => Promise<void>;
  clearPersistenceSession: () => Promise<void>;
  message: string;
  suspend: () => Promise<void>;
}): Promise<void> {
  const failures: unknown[] = [];
  try {
    await suspend();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  try {
    await clearPersistenceSession();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  try {
    await clearFileSystemSession();
  } catch (cause: unknown) {
    failures.push(cause);
  }
  clearBackend();
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
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
  private unlockedEncryptionSession: OpfsPersistenceUnlockedSession | undefined;
  private persistenceRuntime: OpfsPersistenceRuntime | undefined;
  private uninstallActiveHizoFSContainerLocation: (() => void) | undefined;
  private unlockedMaintenanceCompletion: Promise<void> | undefined;
  private readonly hostVolumeDB = new HostVolumeDB();
  private readonly plainNamespaceSessionLock = new OpfsPlainNamespaceSessionLock();
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
          || !(await hasPersistenceControlDirectory({ storageRoot }))
        ) {
          await this.plainNamespaceSessionLock.acquire();
          this.backend = await this.createPlainBackend();
          return;
        }

        const inspection = await this.inspectEncryption();
        switch (inspection.type) {
        case 'plain': {
          await this.plainNamespaceSessionLock.acquire();
          this.backend = await this.createPlainBackend();
          const runtime = await this.requirePersistenceRuntime();
          const nativeNamespaceRoot = await navigator.storage.getDirectory();
          void runtime.runStartupMaintenance({ nativeNamespaceRoot, storageRoot }).catch(error => {
            // WHY: Retired-source cleanup is retryable maintenance after stable
            // authority publication. Its failure must not prevent ordinary
            // Naidan reads and writes from using the stable plain backend.
            console.error('[opfs-encryption] deferred startup maintenance failed', error);
          });
          return;
        }
        case 'credential_required':
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
      await suspendStorageSessionAfterFailure({
        cause: error,
        message: 'OPFS storage initialization and session suspension both failed',
        suspend: async () => await this.suspendSessionLocks(),
      });
    }
  }

  async inspectEncryption(): Promise<OpfsEncryptionInspection> {
    const storageRoot = await getStorageRootIfPresent();
    if (storageRoot === undefined || !(await hasPersistenceControlDirectory({ storageRoot }))) {
      return { type: 'plain' };
    }
    try {
      return await (await this.requirePersistenceRuntime()).inspect({ storageRoot });
    } catch (error) {
      return { type: 'recovery_required', error };
    }
  }

  async inspectEncryptionSettings(): Promise<OpfsEncryptionSettingsInspection> {
    return projectEncryptionSettingsInspection({
      inspection: await this.inspectEncryption(),
      unlockedSession: this.unlockedEncryptionSession,
    });
  }

  async unlockWithPassphrase({ passphrase }: { passphrase: string }): Promise<void> {
    await this.storageSessionLock.acquire();
    try {
      await this.storageSessionLock.run({ run: async () => {
        const storageRoot = await getStorageRootIfPresent();
        if (storageRoot === undefined) throw new Error('OPFS storage root does not exist');
        requireUnlockableInspection({ inspection: await this.inspectEncryption() });
        const runtime = await this.requirePersistenceRuntime();
        const session = await runtime.unlockWithPassphrase({
          passphrase,
          storageRoot,
        });
        await this.installPersistenceSession({ session });
        reportHizoFSTrialDebug({
          detail: { event: 'unlock', fileSystemId: session.fileSystemId, stage: 'backend_installed' },
          level: 'info',
        });
        const nativeNamespaceRoot = await navigator.storage.getDirectory();
        const maintenanceCompletion = runtime.runUnlockedMaintenance({ nativeNamespaceRoot, session, storageRoot }).then(
          () => undefined,
          error => {
            // WHY: Stable HizoFS is already authoritative and usable. Retired
            // source deletion is opportunistic maintenance and must never turn
            // a successful unlock into an application startup failure.
            console.error('[opfs-encryption] unlocked persistence maintenance failed', error);
          },
        );
        this.unlockedMaintenanceCompletion = maintenanceCompletion;
        void maintenanceCompletion.finally(() => {
          if (this.unlockedMaintenanceCompletion === maintenanceCompletion) {
            this.unlockedMaintenanceCompletion = undefined;
          }
        });
      } });
    } catch (error) {
      await suspendStorageSessionAfterFailure({
        cause: error,
        message: 'OPFS unlock and session suspension both failed',
        suspend: async () => await this.suspendSessionLocks(),
      });
    }
  }

  async lockEncryption(): Promise<void> {
    await settleStorageProviderShutdown({
      clearBackend: () => {
        this.backend = undefined;
      },
      clearFileSystemSession: async () => await this.closeFileSystemSession(),
      clearPersistenceSession: async () => await this.clearPersistenceSession(),
      message: 'OPFS encryption lock cleanup failed',
      suspend: async () => await this.suspendSessionLocks(),
    });
  }

  async suspendStorageSession(): Promise<void> {
    await this.suspendSessionLocks();
  }

  override async dispose(): Promise<void> {
    await settleStorageProviderShutdown({
      clearBackend: () => {
        this.backend = undefined;
      },
      clearFileSystemSession: async () => await this.closeFileSystemSession(),
      clearPersistenceSession: async () => await this.clearPersistenceSession(),
      message: 'OPFS storage disposal failed',
      suspend: async () => await this.suspendSessionLocks(),
    });
  }

  async enableEncryption({ passphrase, signal, onProgress }: {
    passphrase: string;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<void> {
    requirePlainInspection({ inspection: await this.inspectEncryption() });
    await this.runPersistenceTransition({
      onProgress,
      request: { operation: 'enable', passphrase },
      signal,
    });
  }

  async changePassphrase({ passphrase }: { passphrase: string }): Promise<void> {
    await this.storageSessionLock.run({ run: async () => {
      await this.unlockedMaintenanceCompletion;
      const session = this.requireUnlockedEncryptionSession();
      const storageRoot = await getOrCreateStorageRoot();
      const nextSession = await (await this.requirePersistenceRuntime()).changePassphrase({
        passphrase,
        session,
        storageRoot,
      });
      await this.installPersistenceSession({ session: nextSession });
    } });
  }

  async disableEncryption({ signal, onProgress }: {
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<void> {
    await this.runPersistenceTransition({
      onProgress,
      request: { operation: 'disable', session: this.requireUnlockedEncryptionSession() },
      signal,
    });
  }

  async reencrypt({ retainedCredentials, signal, onProgress }: {
    retainedCredentials: Extract<OpfsPersistenceTransitionRequest, { readonly operation: 'reencrypt' }>['retainedCredentials'];
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<void> {
    await this.runPersistenceTransition({
      onProgress,
      request: { operation: 'reencrypt', retainedCredentials, session: this.requireUnlockedEncryptionSession() },
      signal,
    });
  }

  async convergeTransitionWithPassphrase({ passphrase, signal }: {
    passphrase: string;
    signal: AbortSignal | undefined;
  }): Promise<void> {
    const inspection = await this.inspectEncryption();
    switch (inspection.type) {
    case 'transitioning': break;
    case 'credential_required':
      switch (inspection.requiredAction) {
      case 'converge_transition': break;
      case 'unlock':
        throw new Error('OPFS transition cannot be converged from a stable credential-required state');
      default: inspection.requiredAction satisfies never;
      }
      break;
    case 'plain':
    case 'encrypted':
    case 'recovery_required':
      throw new Error(`OPFS transition cannot be converged from state: ${inspection.type}`);
    default: inspection satisfies never;
    }
    await this.runPersistenceTransition({
      onProgress: undefined,
      request: { operation: 'converge', retainedCredentials: [{ passphrase }] },
      signal,
    });
  }

  async returnInterruptedEncryptionToPlain({ passphrase, signal, onProgress }: {
    passphrase: string;
    signal: AbortSignal | undefined;
    onProgress?: OpfsEncryptionTransitionProgressListener;
  }): Promise<void> {
    requireReturnToPlainInspection({ inspection: await this.inspectEncryption() });
    await this.runPersistenceTransition({
      onProgress,
      request: { operation: 'return_to_plain', passphrase },
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

  private async requirePersistenceRuntime(): Promise<OpfsPersistenceRuntime> {
    this.persistenceRuntime ??= await createInstalledOpfsPersistenceRuntime();
    return this.persistenceRuntime;
  }

  private async runPersistenceTransition({ onProgress, request, signal }: {
    onProgress: OpfsEncryptionTransitionProgressListener | undefined;
    request: OpfsPersistenceTransitionRequest;
    signal: AbortSignal | undefined;
  }): Promise<void> {
    // Unlocked maintenance may temporarily own the same proof-scoped HizoFS
    // session needed by disable or re-encryption. Management transitions wait
    // for that opportunistic work to settle before suspending shared sessions.
    await this.unlockedMaintenanceCompletion;
    await this.suspendSessionLocks();
    try {
      const storageRoot = await getOrCreateStorageRoot();
      await runWithExclusiveOpfsStorageSessionFence({
        lockManager: navigator.locks,
        run: async () => await (await this.requirePersistenceRuntime()).runTransition({
          nativeNamespaceRoot: await navigator.storage.getDirectory(),
          onProgress,
          request,
          signal,
          storageRoot,
        }),
        signal,
      });
      await settleProviderForReloadAfterTransition({
        settleProvider: async () => await settleStorageProviderShutdown({
          clearBackend: () => {
            this.backend = undefined;
          },
          clearFileSystemSession: async () => await this.closeFileSystemSession(),
          clearPersistenceSession: async () => await this.clearPersistenceSession(),
          message: 'OPFS provider cleanup before reload failed',
          suspend: async () => await this.suspendSessionLocks(),
        }),
      });
    } catch (error) {
      await settleProviderAfterTransitionFailure({
        cause: error,
        message: 'OPFS persistence transition and reload shutdown both failed',
        settle: async () => await settleStorageProviderShutdown({
          clearBackend: () => {
            this.backend = undefined;
          },
          clearFileSystemSession: async () => await this.closeFileSystemSession(),
          clearPersistenceSession: async () => await this.clearPersistenceSession(),
          message: 'OPFS provider shutdown after transition failure failed',
          suspend: async () => await this.suspendSessionLocks(),
        }),
      });
    }
  }

  private async installPersistenceSession({ session }: {
    session: OpfsPersistenceUnlockedSession;
  }): Promise<void> {
    switch (session.writableProfile) {
    case 'development-unverified':
      console.warn(
        '[hizofs] writable development profile is active; crash durability is not release-qualified',
      );
      break;
    case 'release-qualified': break;
    default: session.writableProfile satisfies never;
    }
    if (this.unlockedEncryptionSession === session) {
      this.fileSystemSession = session.fileSystemSession;
      this.backend = session.backend;
      return;
    }
    let uninstallActiveLocation: () => void;
    try {
      await this.clearPersistenceSession();
      await this.closeFileSystemSession();
      uninstallActiveLocation = installActiveAuthenticatedHizoFSContainerLocation({
        fileSystemId: session.fileSystemId,
      });
    } catch (cause: unknown) {
      return await closePersistenceSessionAfterInstallFailure({ cause, session });
    }
    this.unlockedEncryptionSession = session;
    this.fileSystemSession = session.fileSystemSession;
    this.backend = session.backend;
    this.uninstallActiveHizoFSContainerLocation = uninstallActiveLocation;
  }

  private async clearPersistenceSession(): Promise<void> {
    await this.unlockedMaintenanceCompletion;
    const uninstallActiveLocation = this.uninstallActiveHizoFSContainerLocation;
    this.uninstallActiveHizoFSContainerLocation = undefined;
    uninstallActiveLocation?.();
    const session = this.unlockedEncryptionSession;
    this.unlockedEncryptionSession = undefined;
    if (session !== undefined && this.fileSystemSession === session.fileSystemSession) {
      this.fileSystemSession = undefined;
    }
    await session?.close();
  }

  private async suspendSessionLocks(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.plainNamespaceSessionLock.suspend();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    try {
      await this.storageSessionLock.suspend();
    } catch (cause: unknown) {
      failures.push(cause);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'OPFS storage and plain namespace session suspension both failed');
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
    } catch (cause: unknown) {
      return await closePlainSessionAfterBackendInitializationFailure({
        cause,
        fileSystemSession: nextSession,
      });
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

  private requireUnlockedEncryptionSession(): OpfsPersistenceUnlockedSession {
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
  closePersistenceSessionAfterInstallFailure,
  closePlainSessionAfterBackendInitializationFailure,
  requireReturnToPlainInspection,
  settleProviderAfterTransitionFailure,
  settleProviderForReloadAfterTransition,
  settleStorageProviderShutdown,
  suspendStorageSessionAfterFailure,
  getOrCreateStorageRoot,
  getStorageRootIfPresent,
  hasPersistenceControlDirectory,
  projectEncryptionSettingsInspection,
};
