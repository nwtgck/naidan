import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, ChatMeta, ChatContent, Hierarchy, MessageNode, StorageSnapshot, BinaryObject, Volume, VolumeType, Mount } from '@/01-models/types';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move storage notification text translation to the application layer.
import { ensureStrings } from '@/strings';
import type { IStorageProvider } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { NaidanOpfsStorageBackend } from './naidan-opfs/backend';
import { HostVolumeDB } from './opfs/host-volume-db';
import { createNativeOpfsFileSystemSession } from './storage-file-system/native-opfs';
import type {
  OpfsEncryptionInspection,
  OpfsEncryptionSettingsInspection,
} from './naidan-opfs/persistence-runtime-contract';
import type { OpfsEncryptionTransitionProgressListener } from './naidan-opfs/transition-progress';
import type { OpfsSpecialFileSystemType } from './opfs/opfs-special-file-system';
import {
  notifyRegisteredOpfsExternalTransitionSettled,
  notifyRegisteredOpfsExternalTransitionStarting,
  notifyRegisteredOpfsLocalTransitionSettled,
  notifyRegisteredOpfsLocalTransitionStarting,
  prepareRegisteredOpfsStorageTransition,
} from './opfs/opfs-storage-transition-preparation';
import { MemoryStorageProvider } from './memory-storage';
import { checkOPFSSupport } from '@/utils/opfs-detection';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the application event dependency with a storage service event API.
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { STORAGE_BOOTSTRAP_KEY, SYNC_LOCK_KEY, LOCK_METADATA, LOCK_CHAT_CONTENT_PREFIX } from '@/constants';
import { chatToDto, hierarchyToDomain, hierarchyToDto } from '@/00-storage/mapper/mappers';
import type { MigrationChunkDto } from '@/00-storage/00-dto/dto';
import type { BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';
import { StorageSynchronizer, type ChangeListener, type StorageChangeEvent } from './synchronizer';
import { idToRaw, toChatId } from '@/01-models/ids';

type OpfsEncryptionChangeEvent = Extract<StorageChangeEvent, { type: 'opfs_encryption' }>;

type TransitionErrorDiagnosticEntry = Readonly<{
  errorCode: string | undefined;
  errorMessage: string;
  errorName: string;
  errorPath: string | undefined;
}>;

function transitionErrorDiagnosticEntry({ error }: { error: unknown }): TransitionErrorDiagnosticEntry {
  if (!(error instanceof Error)) {
    return {
      errorCode: undefined,
      errorMessage: String(error),
      errorName: typeof error,
      errorPath: undefined,
    };
  }
  const detailed = error as Error & { code?: unknown; path?: unknown };
  return {
    errorCode: typeof detailed.code === 'string' ? detailed.code : undefined,
    errorMessage: error.message,
    errorName: error.name,
    errorPath: typeof detailed.path === 'string' ? detailed.path : undefined,
  };
}

function transitionErrorDiagnostics({
  error,
}: {
  error: unknown;
}): TransitionErrorDiagnosticEntry & {
  errorCauses: readonly TransitionErrorDiagnosticEntry[];
} {
  return {
    ...transitionErrorDiagnosticEntry({ error }),
    errorCauses: error instanceof AggregateError
      ? Array.from(error.errors).slice(0, 8).map(cause => transitionErrorDiagnosticEntry({ error: cause }))
      : [],
  };
}

function createStorageSynchronizationId({ prefix }: { prefix: string }): string {
  const randomId = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${randomId}`;
}

function throwOpfsTransitionFailures({ failures, message }: {
  failures: readonly unknown[];
  message: string;
}): never {
  const [failure] = failures;
  if (failure === undefined && failures.length === 0) {
    throw new TypeError('OPFS transition failure aggregation requires at least one failure');
  }
  if (failures.length === 1) throw failure;
  throw new AggregateError(failures, message);
}


/**
 * StorageService
 *
 * Orchestrates atomic storage operations across multiple tabs using Web Locks.
 *
 * FUTURE DIRECTION:
 * We are moving away from positional save methods (e.g. saveChat with index)
 * towards a decoupled "Load-and-Update" pattern.
 * Use `updateHierarchy` for structural changes.
 */
export class StorageService {
  private provider: IStorageProvider | null = null;
  private currentType: 'local' | 'opfs' | 'memory' | null = null;
  private synchronizer: StorageSynchronizer;
  private readonly synchronizationTabId = createStorageSynchronizationId({ prefix: 'tab' });
  private externalTransitionEventQueue: Promise<void> = Promise.resolve();
  private pendingExternalTransitionOperationId: string | undefined;
  private readonly settledExternalTransitionOperationIds = new Set<string>();
  private readonly ignoredExternalTransitionOperationIds = new Set<string>();
  private externalOpfsTransitionEpoch = 0;

  constructor() {
    this.synchronizer = new StorageSynchronizer();
    this.synchronizer.subscribe({ listener: ({ event }) => {
      const eventType = event.type;
      switch (eventType) {
      case 'opfs_encryption': {
        this.enqueueExternalOpfsEncryptionTransition({ event });
        return;
      }
      case 'chat_meta_and_chat_group':
      case 'chat_content':
      case 'chat_content_generation':
      case 'settings':
      case 'binary_objects':
      case 'migration':
        return;
      default: {
        const _ex: never = eventType;
        throw new Error(`Unhandled storage change event type: ${String(_ex)}`);
      }
      }
    } });
  }

  private enqueueExternalOpfsEncryptionTransition({
    event,
  }: {
    event: OpfsEncryptionChangeEvent,
  }): void {
    this.externalTransitionEventQueue = this.externalTransitionEventQueue
      .then(async () => await this.handleExternalOpfsEncryptionTransition({ event }))
      .catch(error => {
        console.error('Failed to handle an external OPFS encryption transition:', error);
      });
  }

  private async handleExternalOpfsEncryptionTransition({
    event,
  }: {
    event: OpfsEncryptionChangeEvent,
  }): Promise<void> {
    if (event.initiatorTabId === this.synchronizationTabId) {
      return;
    }

    const status = event.status;
    switch (status) {
    case 'transition_started': {
      if (
        this.settledExternalTransitionOperationIds.has(event.operationId)
        || this.ignoredExternalTransitionOperationIds.has(event.operationId)
      ) {
        return;
      }
      this.externalOpfsTransitionEpoch += 1;
      const preparation = await this.suspendOpfsStorageForExternalTransition({
        operationId: event.operationId,
      });
      switch (preparation) {
      case 'suspended':
        return;
      case 'unaffected':
        // A tab that has not installed OPFS yet (or uses another provider)
        // cannot hold the shared OPFS session that the initiator is waiting
        // for. If it later initializes OPFS, the global storage lock ensures
        // that initialization happens after this transition has settled and
        // therefore already observes the winner's stable backend.
        this.rememberIgnoredExternalTransition({ operationId: event.operationId });
        return;
      default: {
        const _ex: never = preparation;
        throw new Error(`Unhandled external OPFS transition preparation: ${String(_ex)}`);
      }
      }
    }
    case 'transition_completed':
      if (this.consumeIgnoredExternalTransition({ operationId: event.operationId })) {
        this.rememberSettledExternalTransition({ operationId: event.operationId });
        return;
      }
      if (this.settledExternalTransitionOperationIds.has(event.operationId)) {
        return;
      }
      this.externalOpfsTransitionEpoch += 1;
      if (this.pendingExternalTransitionOperationId !== event.operationId) {
        const preparation = await this.suspendOpfsStorageForExternalTransition({
          operationId: event.operationId,
        });
        switch (preparation) {
        case 'suspended':
          break;
        case 'unaffected':
          this.rememberSettledExternalTransition({ operationId: event.operationId });
          return;
        default: {
          const _ex: never = preparation;
          throw new Error(`Unhandled external OPFS transition preparation: ${String(_ex)}`);
        }
        }
      }
      this.rememberSettledExternalTransition({ operationId: event.operationId });
      this.settleExternalOpfsStorageTransition({
        operationId: event.operationId,
        settlement: 'completed',
      });
      return;
    case 'transition_failed':
      if (this.consumeIgnoredExternalTransition({ operationId: event.operationId })) {
        this.rememberSettledExternalTransition({ operationId: event.operationId });
        return;
      }
      if (this.settledExternalTransitionOperationIds.has(event.operationId)) {
        return;
      }
      this.externalOpfsTransitionEpoch += 1;
      if (this.pendingExternalTransitionOperationId !== event.operationId) {
        const preparation = await this.suspendOpfsStorageForExternalTransition({
          operationId: event.operationId,
        });
        switch (preparation) {
        case 'suspended':
          break;
        case 'unaffected':
          this.rememberSettledExternalTransition({ operationId: event.operationId });
          return;
        default: {
          const _ex: never = preparation;
          throw new Error(`Unhandled external OPFS transition preparation: ${String(_ex)}`);
        }
        }
      }
      this.rememberSettledExternalTransition({ operationId: event.operationId });
      this.settleExternalOpfsStorageTransition({
        operationId: event.operationId,
        settlement: 'failed',
      });
      return;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled OPFS encryption transition status: ${String(_ex)}`);
    }
    }
  }

  private rememberIgnoredExternalTransition({
    operationId,
  }: {
    operationId: string,
  }): void {
    this.ignoredExternalTransitionOperationIds.add(operationId);
    const maximumRememberedOperations = 32;
    while (this.ignoredExternalTransitionOperationIds.size > maximumRememberedOperations) {
      const oldestOperationId = this.ignoredExternalTransitionOperationIds.values().next().value;
      if (oldestOperationId === undefined) {
        return;
      }
      this.ignoredExternalTransitionOperationIds.delete(oldestOperationId);
    }
  }

  private consumeIgnoredExternalTransition({
    operationId,
  }: {
    operationId: string,
  }): boolean {
    return this.ignoredExternalTransitionOperationIds.delete(operationId);
  }

  private rememberSettledExternalTransition({
    operationId,
  }: {
    operationId: string,
  }): void {
    this.settledExternalTransitionOperationIds.add(operationId);
    const maximumRememberedOperations = 32;
    while (this.settledExternalTransitionOperationIds.size > maximumRememberedOperations) {
      const oldestOperationId = this.settledExternalTransitionOperationIds.values().next().value;
      if (oldestOperationId === undefined) {
        return;
      }
      this.settledExternalTransitionOperationIds.delete(oldestOperationId);
    }
  }

  private async suspendOpfsStorageForExternalTransition({
    operationId,
  }: {
    operationId: string,
  }): Promise<'suspended' | 'unaffected'> {
    if (this.currentType !== 'opfs' || !(this.provider instanceof OPFSStorageProvider)) {
      return 'unaffected';
    }
    if (this.pendingExternalTransitionOperationId === operationId) {
      return 'suspended';
    }
    if (this.pendingExternalTransitionOperationId !== undefined) {
      throw new Error('A different external OPFS encryption transition is already pending');
    }

    const presentationFailures: unknown[] = [];
    try {
      await notifyRegisteredOpfsExternalTransitionStarting();
    } catch (error: unknown) {
      presentationFailures.push(error);
    }

    const safetyPreparationFailures: unknown[] = [];
    try {
      await prepareRegisteredOpfsStorageTransition();
    } catch (error: unknown) {
      safetyPreparationFailures.push(error);
    }

    if (safetyPreparationFailures.length > 0) {
      // A failed native-capability cleanup keeps this tab's shared lease.
      // The initiator must time out before touching Persistence Control.
      const failures = [...presentationFailures, ...safetyPreparationFailures];
      try {
        notifyRegisteredOpfsExternalTransitionSettled({
          settlement: 'preparation_failed',
        });
      } catch (settlementError: unknown) {
        failures.push(settlementError);
      }
      this.rememberSettledExternalTransition({ operationId });
      throwOpfsTransitionFailures({
        failures,
        message: 'External OPFS transition presentation and safety preparation failed',
      });
    }

    try {
      await this.provider.suspendStorageSession();
      this.pendingExternalTransitionOperationId = operationId;
    } catch (suspensionError: unknown) {
      const failures = [...presentationFailures, suspensionError];
      try {
        notifyRegisteredOpfsExternalTransitionSettled({
          settlement: 'preparation_failed',
        });
      } catch (settlementError: unknown) {
        failures.push(settlementError);
      }
      this.rememberSettledExternalTransition({ operationId });
      throwOpfsTransitionFailures({
        failures,
        message: 'External OPFS transition presentation and session suspension failed',
      });
    }

    if (presentationFailures.length > 0) {
      this.pendingExternalTransitionOperationId = undefined;
      const failures = [...presentationFailures];
      try {
        notifyRegisteredOpfsExternalTransitionSettled({ settlement: 'preparation_failed' });
      } catch (settlementError: unknown) {
        failures.push(settlementError);
      }
      this.rememberSettledExternalTransition({ operationId });
      throwOpfsTransitionFailures({
        failures,
        message: 'External OPFS transition presentation failed after safe session suspension',
      });
    }
    return 'suspended';
  }

  private settleExternalOpfsStorageTransition({
    operationId,
    settlement,
  }: {
    operationId: string,
    settlement: 'completed' | 'failed',
  }): void {
    if (this.pendingExternalTransitionOperationId !== operationId) {
      return;
    }
    this.pendingExternalTransitionOperationId = undefined;
    notifyRegisteredOpfsExternalTransitionSettled({ settlement });
  }

  /**
   * Returns the current storage provider.
   */
  private getProvider(): IStorageProvider {
    if (!this.provider) {
      throw new Error('StorageService not initialized. Call init() first.');
    }
    return this.provider;
  }


  private getOpfsProvider(): OPFSStorageProvider {
    const provider = this.getProvider();
    if (!(provider instanceof OPFSStorageProvider)) {
      throw new Error('The current storage provider is not OPFS.');
    }
    return provider;
  }

  private async runOpfsEncryptionTransition<T>({
    run,
  }: {
    run: () => Promise<T>,
  }): Promise<T> {
    const operationId = createStorageSynchronizationId({ prefix: 'operation' });
    const externalTransitionEpochAtRequest = this.externalOpfsTransitionEpoch;
    return await this.synchronizer.withLock({
      fn: async () => {
        if (externalTransitionEpochAtRequest !== this.externalOpfsTransitionEpoch) {
          // This request waited behind a transition started by another tab.
          // Do not begin a second transition from stale UI state after the
          // winner settles; the caller will re-inspect the stable backend.
          throw new Error('OPFS encryption transition was superseded by another tab');
        }

        const preflightFailures: unknown[] = [];
        try {
          notifyRegisteredOpfsLocalTransitionStarting();
        } catch (error: unknown) {
          preflightFailures.push(error);
        }
        try {
          await prepareRegisteredOpfsStorageTransition();
        } catch (error: unknown) {
          preflightFailures.push(error);
        }
        if (preflightFailures.length > 0) {
          try {
            notifyRegisteredOpfsLocalTransitionSettled({ settlement: 'preparation_failed' });
          } catch (settlementError: unknown) {
            preflightFailures.push(settlementError);
          }
          throwOpfsTransitionFailures({
            failures: preflightFailures,
            message: 'Local OPFS transition preflight failed',
          });
        }

        // Announce the transition only after holding the global storage lock.
        // A tab that starts concurrently must wait here before it can initialize
        // OPFS and acquire a long-lived shared OPFS session lock. Otherwise it
        // could miss this broadcast and keep the transition's exclusive lock
        // waiting indefinitely.
        this.notify({
          event: {
            type: 'opfs_encryption',
            status: 'transition_started',
            operationId,
            initiatorTabId: this.synchronizationTabId,
            timestamp: Date.now(),
          },
        });
        console.info('[opfs-encryption]', {
          event: 'transition_started',
          operationId,
          tabId: this.synchronizationTabId,
        });

        let result: T;
        try {
          result = await run();
        } catch (error: unknown) {
          const failures = [error];
          try {
            this.notify({
              event: {
                type: 'opfs_encryption',
                status: 'transition_failed',
                operationId,
                initiatorTabId: this.synchronizationTabId,
                timestamp: Date.now(),
              },
            });
          } catch (notificationError: unknown) {
            failures.push(notificationError);
          }
          console.error('[opfs-encryption]', {
            event: 'transition_failed',
            operationId,
            tabId: this.synchronizationTabId,
            error,
            ...transitionErrorDiagnostics({ error }),
          });
          try {
            notifyRegisteredOpfsLocalTransitionSettled({ settlement: 'failed' });
          } catch (settlementError: unknown) {
            failures.push(settlementError);
          }
          throwOpfsTransitionFailures({
            failures,
            message: 'OPFS transition and failure settlement failed',
          });
        }

        const completionFailures: unknown[] = [];
        try {
          this.notify({
            event: {
              type: 'opfs_encryption',
              status: 'transition_completed',
              operationId,
              initiatorTabId: this.synchronizationTabId,
              timestamp: Date.now(),
            },
          });
        } catch (notificationError: unknown) {
          completionFailures.push(notificationError);
        }
        console.info('[opfs-encryption]', {
          event: 'transition_completed',
          operationId,
          tabId: this.synchronizationTabId,
        });
        try {
          notifyRegisteredOpfsLocalTransitionSettled({ settlement: 'completed' });
        } catch (settlementError: unknown) {
          completionFailures.push(settlementError);
        }
        if (completionFailures.length > 0) {
          throwOpfsTransitionFailures({
            failures: completionFailures,
            message: 'OPFS transition completion settlement failed',
          });
        }
        return result;
      },
      lockKey: SYNC_LOCK_KEY,
      ...this.getLockOptions({
        source: 'opfsEncryptionTransition',
        custom: { notifyLockWaitAfterMs: 5000 },
      }),
    });
  }

  async init({ type }: { type: 'local' | 'opfs' | 'memory' }) {
    await this.synchronizer.withLock({ fn: async () => {
      const isOPFSSupported = await checkOPFSSupport();
      let targetType: 'local' | 'opfs' | 'memory' = type;

      if (targetType === 'opfs' && !isOPFSSupported) {
        targetType = 'local';
      }

      this.currentType = targetType;

      switch (this.currentType) {
      case 'opfs':
        this.provider = new OPFSStorageProvider();
        break;
      case 'local':
        this.provider = new LocalStorageProvider();
        break;
      case 'memory':
        this.provider = new MemoryStorageProvider();
        break;
      default: {
        const _exhaustiveCheck: never = this.currentType;
        throw new Error(`Unhandled currentType: ${_exhaustiveCheck}`);
      }
      }
      await this.provider.init();
    }, lockKey: SYNC_LOCK_KEY, ...this.getLockOptions({ source: 'init' }) });
  }

  getCurrentType(): 'local' | 'opfs' | 'memory' {
    if (!this.currentType) {
      throw new Error('StorageService not initialized. Call init() first.');
    }
    return this.currentType;
  }

  get canPersistBinary(): boolean {
    return this.getProvider().canPersistBinary;
  }

  // --- Synchronization ---

  subscribeToChanges({ listener }: { listener: ChangeListener }) {
    return this.synchronizer.subscribe({ listener });
  }

  notify({ event }: { event: StorageChangeEvent }): void {
    this.synchronizer.notify({ event });
  }

  async inspectOpfsEncryption(): Promise<OpfsEncryptionInspection> {
    const currentType = this.getCurrentType();
    switch (currentType) {
    case 'local':
    case 'memory':
      return { type: 'plain' };
    case 'opfs':
      return await this.getOpfsProvider().inspectEncryption();
    default: {
      const _ex: never = currentType;
      throw new Error(`Unhandled storage type: ${String(_ex)}`);
    }
    }
  }

  async inspectOpfsEncryptionSettings(): Promise<OpfsEncryptionSettingsInspection> {
    const currentType = this.getCurrentType();
    switch (currentType) {
    case 'local':
    case 'memory':
      return { type: 'plain' };
    case 'opfs':
      return await this.getOpfsProvider().inspectEncryptionSettings();
    default: {
      const _ex: never = currentType;
      throw new Error(`Unhandled storage type: ${String(_ex)}`);
    }
    }
  }

  async unlockOpfsEncryptionWithPassphrase({
    passphrase,
  }: {
    passphrase: string,
  }): Promise<void> {
    await this.getOpfsProvider().unlockWithPassphrase({ passphrase });
  }



  async retryPlainOpfsInitializationAfterEncryptionRecovery(): Promise<void> {
    await this.getOpfsProvider().init();
  }


  async lockOpfsEncryption(): Promise<void> {
    await this.getOpfsProvider().lockEncryption();
  }

  async enableOpfsEncryption({
    passphrase,
    signal,
    onProgress,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
    onProgress?: OpfsEncryptionTransitionProgressListener,
  }): Promise<void> {
    await this.runOpfsEncryptionTransition({
      run: async () => await this.getOpfsProvider().enableEncryption({
        passphrase,
        signal,
        onProgress,
      }),
    });
  }

  async changeOpfsEncryptionPassphrase({
    passphrase,
  }: {
    passphrase: string,
  }): Promise<void> {
    await this.synchronizer.withLock({
      fn: async () => await this.getOpfsProvider().changePassphrase({ passphrase }),
      lockKey: SYNC_LOCK_KEY,
      ...this.getLockOptions({ source: 'changeOpfsEncryptionPassphrase' }),
    });
  }

  async disableOpfsEncryption({
    signal,
    onProgress,
  }: {
    signal: AbortSignal | undefined,
    onProgress?: OpfsEncryptionTransitionProgressListener,
  }): Promise<void> {
    await this.runOpfsEncryptionTransition({
      run: async () => await this.getOpfsProvider().disableEncryption({ signal, onProgress }),
    });
  }

  async reencryptOpfsEncryption({
    passphrase,
    signal,
    onProgress,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
    onProgress?: OpfsEncryptionTransitionProgressListener,
  }): Promise<void> {
    await this.runOpfsEncryptionTransition({
      run: async () => await this.getOpfsProvider().reencrypt({
        retainedCredentials: [{ passphrase }],
        signal,
        onProgress,
      }),
    });
  }

  async convergeOpfsEncryptionTransitionWithPassphrase({
    passphrase,
    signal,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    await this.runOpfsEncryptionTransition({
      run: async () => await this.getOpfsProvider().convergeTransitionWithPassphrase({
        passphrase,
        signal,
      }),
    });
  }

  async returnInterruptedOpfsEncryptionToPlain({
    passphrase,
    signal,
    onProgress,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
    onProgress?: OpfsEncryptionTransitionProgressListener,
  }): Promise<void> {
    await this.runOpfsEncryptionTransition({
      run: async () => await this.getOpfsProvider().returnInterruptedEncryptionToPlain({
        passphrase,
        signal,
        onProgress,
      }),
    });
  }

  async createInterruptedOpfsEncryptionForDebug({
    passphrase,
    signal,
  }: {
    passphrase: string,
    signal: AbortSignal | undefined,
  }): Promise<void> {
    await this.runOpfsEncryptionTransition({
      run: async () => await this.getOpfsProvider().createInterruptedEncryptionForDebug({
        passphrase,
        signal,
      }),
    });
  }

  async createInterruptedOpfsDecryptionForDebug({
    signal,
  }: {
    signal: AbortSignal | undefined,
  }): Promise<void> {
    await this.runOpfsEncryptionTransition({
      run: async () => await this.getOpfsProvider().createInterruptedDecryptionForDebug({ signal }),
    });
  }


  // --- Hierarchy Management (Atomic) ---

  async loadHierarchy(): Promise<Hierarchy> {
    const dto = await this.getProvider().loadHierarchy();
    return dto ? hierarchyToDomain({ dto }) : { items: [] };
  }

  /**
   * Performs an atomic update on the sidebar hierarchy.
   * Prevents lost updates when multiple tabs are reordering or adding chats.
   */
  async updateHierarchy({ updater }: { updater: ({ current }: { current: Hierarchy }) => Hierarchy | Promise<Hierarchy> }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        const current = await this.loadHierarchy();
        const updated = await updater({ current: current });
        await this.getProvider().saveHierarchy({ hierarchy: hierarchyToDto({ domain: updated }) });
      }, lockKey: LOCK_METADATA, ...this.getLockOptions({ source: 'updateHierarchy' }) });
      this.notify({ event: { type: 'chat_meta_and_chat_group', timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'updateHierarchy' });
      throw e;
    }
  }

  // --- Persistence Methods ---

  async updateChatMeta({ id, updater }: { id: ChatId, updater: ({ current }: { current: ChatMeta | null }) => ChatMeta | Promise<ChatMeta> }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        const current = await this.loadChatMeta({ id });
        const updated = await updater({ current: current });
        await this.getProvider().saveChatMeta({ meta: updated });
      }, lockKey: LOCK_METADATA, ...this.getLockOptions({ source: 'updateChatMeta' }) });
      this.notify({ event: { type: 'chat_meta_and_chat_group', id: idToRaw({ id }), timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'updateChatMeta' });
      throw e;
    }
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    return this.getProvider().loadChatMeta({ id });
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return this.getProvider().loadChatContent({ id });
  }

  async loadChatContentWithoutAttachments({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return this.getProvider().loadChatContentWithoutAttachments({ id });
  }

  async updateChatContent({ id, updater }: { id: ChatId, updater: ({ current }: { current: ChatContent | null }) => ChatContent | Promise<ChatContent> }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        const current = await this.loadChatContent({ id });
        const updated = await updater({ current: current });
        await this.getProvider().saveChatContent({ id, content: updated });
      }, lockKey: `${LOCK_CHAT_CONTENT_PREFIX}${idToRaw({ id })}`, ...this.getLockOptions({ source: 'updateChatContent' }) });
      this.notify({ event: { type: 'chat_content', id: idToRaw({ id }), timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'updateChatContent' });
      throw e;
    }
  }

  async loadChat({ id }: { id: ChatId }): Promise<Chat | null> {
    return this.getProvider().loadChat({ id });
  }

  async deleteChat({ id }: { id: ChatId }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        await this.getProvider().deleteChat({ id });
      }, lockKey: LOCK_METADATA, ...this.getLockOptions({ source: 'deleteChat' }) });
      this.notify({ event: { type: 'chat_meta_and_chat_group', id: idToRaw({ id }), timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'deleteChat' });
      throw e;
    }
  }

  async updateChatGroup({ id, updater }: { id: ChatGroupId, updater: ({ current }: { current: ChatGroup | null }) => ChatGroup | Promise<ChatGroup> }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        const current = await this.loadChatGroup({ id });
        const updated = await updater({ current: current });
        await this.getProvider().saveChatGroup({ chatGroup: updated });
      }, lockKey: LOCK_METADATA, ...this.getLockOptions({ source: 'updateChatGroup' }) });
      this.notify({ event: { type: 'chat_meta_and_chat_group', id: idToRaw({ id }), timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'updateChatGroup' });
      throw e;
    }
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    return this.getProvider().loadChatGroup({ id });
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        await this.getProvider().deleteChatGroup({ id });
      }, lockKey: LOCK_METADATA, ...this.getLockOptions({ source: 'deleteChatGroup' }) });
      this.notify({ event: { type: 'chat_meta_and_chat_group', id: idToRaw({ id }), timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'deleteChatGroup' });
      throw e;
    }
  }

  async listChats(): Promise<ChatSummary[]> {
    return this.getProvider().listChats();
  }

  async listChatGroups(): Promise<ChatGroup[]> {
    return this.getProvider().listChatGroups();
  }

  async getSidebarStructure(): Promise<SidebarItem[]> {
    return this.getProvider().getSidebarStructure();
  }

  // --- Settings & Bulk ---

  /**
   * Performs an atomic update on the global settings.
   */
  async updateSettings({ updater }: { updater: ({ current }: { current: Settings | null }) => Settings | Promise<Settings> }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        const current = await this.loadSettings();
        const updated = await updater({ current: current });
        await this.getProvider().saveSettings({ settings: updated });
      }, lockKey: SYNC_LOCK_KEY, ...this.getLockOptions({ source: 'updateSettings' }) });
      this.notify({ event: { type: 'settings', timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'updateSettings' });
      throw e;
    }
  }

  async loadSettings(): Promise<Settings | null> {
    return this.getProvider().loadSettings();
  }

  async clearAll(): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        await this.getProvider().clearAll();
      }, lockKey: SYNC_LOCK_KEY, ...this.getLockOptions({ source: 'clearAll' }) });
      this.notify({ event: { type: 'migration', timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'clearAll' });
      throw e;
    }
  }

  // --- File Storage Methods ---

  async saveFile({ blob, binaryObjectId, name }: {
    blob: Blob,
    binaryObjectId: BinaryObjectId,
    name: string,
  }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        await this.getProvider().saveFile({
          blob,
          binaryObjectId,
          name,
          mimeType: blob.type || undefined,
        });
      }, lockKey: LOCK_METADATA, ...this.getLockOptions({ source: 'saveFile' }) });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'saveFile' });
      throw e;
    }
  }

  async getFile({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | null> {
    return this.getProvider().getFile({ binaryObjectId });
  }

  async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null> {
    return this.getProvider().getBinaryObject({ binaryObjectId });
  }

  async hasAttachments(): Promise<boolean> {
    return this.getProvider().hasAttachments();
  }

  listBinaryObjects(): AsyncIterable<BinaryObject> {
    return this.getProvider().listBinaryObjects();
  }

  async deleteBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        await this.getProvider().deleteBinaryObject({ binaryObjectId });
      }, lockKey: LOCK_METADATA, ...this.getLockOptions({ source: 'deleteBinaryObject' }) });
      this.notify({ event: { type: 'binary_objects', timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'deleteBinaryObject' });
      throw e;
    }
  }

  // --- Volume Management ---

  listVolumes(): AsyncIterable<Volume> {
    return this.getProvider().listVolumes();
  }

  async createVolume({ name, type, sourceHandle }: {
    name: string,
    type: VolumeType,
    sourceHandle: FileSystemDirectoryHandle,
  }): Promise<Volume> {
    return this.getProvider().createVolume({ name, type, sourceHandle });
  }

  async createVolumeFromFiles({ name, entries, onProgress, signal }: {
    name: string,
    entries: Array<{ file: File, relativePath: string }>,
    onProgress?: ({ processed, total }: { processed: number, total: number }) => void,
    signal?: AbortSignal,
  }): Promise<Volume> {
    return this.getProvider().createVolumeFromFiles({ name, entries, onProgress, signal });
  }

  async openVolume({ volumeId }: { volumeId: VolumeId }) {
    return await this.getProvider().openVolume({ volumeId });
  }

  async openOpfsSpecialFileSystemDirectory({
    type,
    path,
    create,
  }: {
    type: OpfsSpecialFileSystemType,
    path: string,
    create: boolean,
  }) {
    const provider = this.getProvider();
    if (provider instanceof OPFSStorageProvider) {
      return await provider.openSpecialFileSystemDirectory({ type, path, create });
    }
    const backend = await this.createNativeNaidanOpfsBackend();
    return await backend.openSpecialFileSystemDirectory({ type, path, create });
  }

  async removeOpfsSpecialFileSystemEntry({
    type,
    path,
    recursive,
  }: {
    type: OpfsSpecialFileSystemType,
    path: string,
    recursive: boolean,
  }): Promise<void> {
    const provider = this.getProvider();
    if (provider instanceof OPFSStorageProvider) {
      await provider.removeSpecialFileSystemEntry({ type, path, recursive });
      return;
    }
    const backend = await this.createNativeNaidanOpfsBackend();
    await backend.removeSpecialFileSystemEntry({ type, path, recursive });
  }

  async clearOpfsSpecialFileSystem({
    type,
  }: {
    type: OpfsSpecialFileSystemType,
  }): Promise<void> {
    const provider = this.getProvider();
    if (provider instanceof OPFSStorageProvider) {
      await provider.clearSpecialFileSystem({ type });
      return;
    }
    const backend = await this.createNativeNaidanOpfsBackend();
    await backend.removeSpecialFileSystemForTransition({ type });
  }

  private async createNativeNaidanOpfsBackend(): Promise<NaidanOpfsStorageBackend> {
    const fileSystemSession = createNativeOpfsFileSystemSession({
      root: await navigator.storage.getDirectory(),
    });
    return new NaidanOpfsStorageBackend({
      namespaceRoot: fileSystemSession.root,
      hostVolumeDB: new HostVolumeDB(),
    });
  }


  async deleteVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    return this.getProvider().deleteVolume({ volumeId });
  }

  async renameVolume({ volumeId, name }: { volumeId: VolumeId, name: string }): Promise<void> {
    return this.getProvider().renameVolume({ volumeId, name });
  }

  async mountVolume({ volumeId, mountPath, readOnly }: {
    volumeId: VolumeId,
    mountPath: string,
    readOnly: boolean,
  }): Promise<void> {
    await this.updateSettings({ updater: ({ current: settings }) => {
      if (!settings) throw new Error('Settings not initialized');
      const exists = settings.mounts.some(m => m.type === 'volume' && m.volumeId === volumeId);
      if (exists) return settings;

      return {
        ...settings,
        mounts: [...settings.mounts, { type: 'volume', volumeId, mountPath, readOnly }],
      };
    } });
  }

  async unmountVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    await this.updateSettings({ updater: ({ current: settings }) => {
      if (!settings) return null as unknown as Settings;
      return {
        ...settings,
        mounts: settings.mounts.filter(m => !(m.type === 'volume' && m.volumeId === volumeId)),
      };
    } });
  }

  async addMountToChat({ chatId, mount }: { chatId: ChatId, mount: Mount }): Promise<void> {
    await this.updateChatMeta({ id: chatId, updater: ({ current }) => {
      if (!current) throw new Error(`Chat not found: ${idToRaw({ id: chatId })}`);
      const existing = current.mounts ?? [];
      return { ...current, mounts: [...existing, mount] };
    } });
  }

  async removeMountFromChat({ chatId, volumeId }: { chatId: ChatId, volumeId: VolumeId }): Promise<void> {
    await this.updateChatMeta({ id: chatId, updater: ({ current }) => {
      if (!current) throw new Error(`Chat not found: ${idToRaw({ id: chatId })}`);
      return {
        ...current,
        mounts: (current.mounts ?? []).filter(m => !(m.type === 'volume' && m.volumeId === volumeId)),
      };
    } });
  }

  async updateChatMount({ chatId, volumeId, readOnly }: { chatId: ChatId, volumeId: VolumeId, readOnly: boolean }): Promise<void> {
    await this.updateChatMeta({ id: chatId, updater: ({ current }) => {
      if (!current) throw new Error(`Chat not found: ${idToRaw({ id: chatId })}`);
      return {
        ...current,
        mounts: (current.mounts ?? []).map(m =>
          m.type === 'volume' && m.volumeId === volumeId ? { ...m, readOnly } : m,
        ),
      };
    } });
  }

  async addMountToChatGroup({ groupId, mount }: { groupId: ChatGroupId, mount: Mount }): Promise<void> {
    await this.updateChatGroup({ id: groupId, updater: ({ current }) => {
      if (!current) throw new Error(`Chat group not found: ${idToRaw({ id: groupId })}`);
      const existing = current.mounts ?? [];
      return { ...current, mounts: [...existing, mount] };
    } });
  }

  async removeMountFromChatGroup({ groupId, volumeId }: { groupId: ChatGroupId, volumeId: VolumeId }): Promise<void> {
    await this.updateChatGroup({ id: groupId, updater: ({ current }) => {
      if (!current) throw new Error(`Chat group not found: ${idToRaw({ id: groupId })}`);
      return {
        ...current,
        mounts: (current.mounts ?? []).filter(m => !(m.type === 'volume' && m.volumeId === volumeId)),
      };
    } });
  }

  async updateChatGroupMount({ groupId, volumeId, mountPath, readOnly }: { groupId: ChatGroupId, volumeId: VolumeId, mountPath: string, readOnly: boolean }): Promise<void> {
    await this.updateChatGroup({ id: groupId, updater: ({ current }) => {
      if (!current) throw new Error(`Chat group not found: ${idToRaw({ id: groupId })}`);
      return {
        ...current,
        mounts: (current.mounts ?? []).map(m =>
          m.type === 'volume' && m.volumeId === volumeId ? { ...m, mountPath, readOnly } : m,
        ),
      };
    } });
  }

  async switchProvider({ type }: { type: 'local' | 'opfs' | 'memory' }) {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        const activeProvider = this.getProvider();
        const oldType = this.getCurrentType();
        if (oldType === type) return;

        const oldProvider = activeProvider;
        const snapshot = await oldProvider.dump();

        const isOPFSSupported = await checkOPFSSupport();
        const newProvider = (() => {
          switch (type) {
          case 'opfs':
            return isOPFSSupported ? new OPFSStorageProvider() : new LocalStorageProvider();
          case 'memory':
            return new MemoryStorageProvider();
          case 'local':
            return new LocalStorageProvider();
          default: {
            const _ex: never = type;
            throw new Error(`Unhandled storage type: ${_ex}`);
          }
          }
        })();

        await newProvider.init();

        // Wrap content stream to rescue memory blobs
        const migrationStream = async function* (): AsyncGenerator<MigrationChunkDto> {
          for await (const chunk of snapshot.contentStream) {
            const chunkType = chunk.type;
            switch (chunkType) {
            case 'chat':
              if (newProvider.canPersistBinary) {
                const chat = await oldProvider.loadChat({ id: toChatId({ raw: chunk.data.id }) });
                if (!chat) {
                  yield chunk; continue;
                }

                const rescued: MigrationChunkDto[] = [];
                const findAndRescue = ({ nodes }: { nodes: MessageNode[] }) => {
                  for (const node of nodes) {
                    if (node.attachments) {
                      for (let i = 0; i < node.attachments.length; i++) {
                        const att = node.attachments[i]!;
                        const status = att.status;
                        switch (status) {
                        case 'memory':
                          if (att.blob) {
                            rescued.push({
                              type: 'binary_object',
                              id: idToRaw({ id: att.binaryObjectId }),
                              name: att.originalName,
                              mimeType: att.blob.type || att.mimeType,
                              size: att.blob.size,
                              createdAt: att.uploadedAt,
                              blob: att.blob,
                            });
                            node.attachments[i] = { ...att, status: 'persisted' as const };
                          }
                          break;
                        case 'persisted':
                        case 'missing':
                          break;
                        default: {
                          const _ex: never = status;
                          throw new Error(`Unhandled attachment status: ${_ex}`);
                        }
                        }
                      }
                    }
                    if (node.replies?.items) findAndRescue({ nodes: node.replies.items });
                  }
                };
                findAndRescue({ nodes: chat.root.items });
                for (const r of rescued) yield r;
                yield { type: 'chat', data: chatToDto({ domain: chat }) };
              } else {
                yield chunk;
              }
              break;
            case 'binary_object':
              yield chunk;
              break;
            default: {
              const _ex: never = chunkType;
              throw new Error(`Unhandled migration chunk type: ${_ex}`);
            }
            }
          }
        };

        let bootstrapTypeUpdated = false;
        try {
          await newProvider.restore({ snapshot: {
            structure: snapshot.structure,
            contentStream: migrationStream(),
          } });

          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_BOOTSTRAP_KEY, type);
            bootstrapTypeUpdated = true;
          }

          await oldProvider.dispose();
        } catch (error) {
          if (bootstrapTypeUpdated && typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_BOOTSTRAP_KEY, oldType);
          }

          try {
            await newProvider.dispose();
          } catch (disposeError) {
            throw new AggregateError(
              [error, disposeError],
              'Storage provider switch failed and the replacement provider could not be disposed',
            );
          }
          throw error;
        }

        this.provider = newProvider;
        this.currentType = type;
      }, lockKey: SYNC_LOCK_KEY, ...this.getLockOptions({ source: 'switchProvider', custom: { notifyLockWaitAfterMs: 5000 } }) });

      this.notify({ event: { type: 'migration', timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'switchProvider' });
      throw e;
    }
  }

  // --- Bulk Operations (Migration / Backup) ---

  /**
   * Dumps the entire storage content as a structured snapshot.
   * WARNING: This generator does not hold a global lock while yielding to allow
   * for memory-efficient streaming. For a consistent snapshot, the caller
   * should ensure no concurrent writes are happening.
   */
  async dumpWithoutLock(): Promise<StorageSnapshot> {
    return this.getProvider().dump();
  }

  /**
   * Restores storage content from a snapshot.
   * This operation is guarded by an exclusive lock as it is destructive.
   */
  async restore({ snapshot }: { snapshot: StorageSnapshot }): Promise<void> {
    try {
      await this.synchronizer.withLock({ fn: async () => {
        await this.getProvider().restore({ snapshot });
      }, lockKey: SYNC_LOCK_KEY, ...this.getLockOptions({ source: 'restore', custom: { notifyLockWaitAfterMs: 5000 } }) });
      this.notify({ event: { type: 'migration', timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'restore' });
      throw e;
    }
  }

  private getLockOptions({ source, custom = {} }: { source: string, custom?: { notifyLockWaitAfterMs?: number } }) {
    return {
      ...custom,
      onLockWait: () => {
        const { addInfoEvent } = useGlobalEvents();
        // TODO(strings-localize): Localize lock lifecycle snapshots without changing these void callback contracts.
        addInfoEvent({
          source: `StorageService:${source}`,
          message: 'Storage is busy. Waiting for other tabs to finish...',
        });
      },
      onTaskSlow: () => {
        const { addInfoEvent } = useGlobalEvents();
        // TODO(strings-localize): Localize lock lifecycle snapshots without changing these void callback contracts.
        addInfoEvent({
          source: `StorageService:${source}`,
          message: 'Storage operation is taking longer than expected...',
        });
      },
      onFinalize: () => {
        const { addInfoEvent } = useGlobalEvents();
        // TODO(strings-localize): Localize lock lifecycle snapshots without changing these void callback contracts.
        addInfoEvent({
          source: `StorageService:${source}`,
          message: 'Storage operation completed.',
        });
      },
    };
  }

  private async handleStorageError({ error, source }: { error: unknown, source: string }) {
    const { addErrorEvent } = useGlobalEvents();
    addErrorEvent({
      source: `StorageService:${source}`,
      message: await ensureStrings.StorageService__an_error_occurred_during_a_storage_operation(),
      details: error instanceof Error ? error : String(error),
    });
  }
}

export const storageService = new StorageService();
export type { ChatSummary };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
