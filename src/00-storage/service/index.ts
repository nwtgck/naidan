import { imageGenerationDraftToDto, imageGenerationDraftToDomain } from '@/00-storage/mapper/image-generation';
import { ExperimentalImageGenerationSchemaDto, ExperimentalImageGenerationDraftSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationToDomain, imageGenerationToDto } from '@/00-storage/mapper/image-generation-history';
import type { ImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationExportSnapshot } from './image-generation-export';
import type { ImageGenerationAsset, ImageGenerationSessionDraft, ImageGenerationRun } from '@/01-models/image-generation';
import type { ImageGenerationStoreAccess } from './image-generation';
import type { ImageGenerationBinaryFile } from './image-generation-binaries';
import { prepareModelLaunchChat, restoreModelLaunch, detachRemovedModelLaunchOwners, readModelLaunch, type ModelLaunchChatRequest } from './model-launch';
import { iterateAttachmentParts } from './message-attachments';
import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, ChatMeta, ChatContent, Hierarchy, StorageSnapshot, BinaryObject, Volume, VolumeType, Mount } from '@/01-models/types';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move storage notification text translation to the application layer.
import { ensureStrings } from '@/strings';
import type { IStorageProvider } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { MemoryStorageProvider } from './memory-storage';
import { checkOPFSSupport } from '@/utils/opfs-detection';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the application event dependency with a storage service event API.
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { STORAGE_BOOTSTRAP_KEY, SYNC_LOCK_KEY, LOCK_METADATA, LOCK_CHAT_CONTENT_PREFIX } from '@/constants';
import { chatToDto, hierarchyToDomain, hierarchyToDto } from '@/00-storage/mapper/mappers';
import type { MigrationChunkDto } from '@/00-storage/00-dto/dto';
import type { BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';
import { StorageSynchronizer, type ChangeListener, type StorageChangeEvent } from './synchronizer';
import { idToRaw, toChatId, toBinaryObjectId } from '@/01-models/ids';
import type { ImageGenerationId } from '@/01-models/ids';
import type { ImageGenerationRecord } from '@/01-models/image-generation-history';
import type { NaidanRpcRegistration } from '@/01-models/naidan-rpc';
import { readNaidanRpcRegistry, writeNaidanRpcRegistry, sameNaidanRpcRegistry } from './naidan-rpc-registry';
import type { NaidanRpcRegistryAccess, NaidanRpcRegistrySnapshot } from './naidan-rpc-registry';


// Match Wesh VFS lexical mount normalization without introducing a storage -> feature dependency.
function normalizeMountPathForComparison({ mountPath }: { mountPath: string }): string {
  const normalizedSegments: string[] = [];
  for (const segment of mountPath.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      normalizedSegments.pop();
      continue;
    }
    normalizedSegments.push(segment);
  }
  return normalizedSegments.length === 0 ? '/' : `/${normalizedSegments.join('/')}`;
}

function mountPathsAreEquivalent({ left, right }: { left: string, right: string }): boolean {
  return normalizeMountPathForComparison({ mountPath: left }) === normalizeMountPathForComparison({ mountPath: right });
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
  private providerGeneration = 0;
  private readonly rpcRegistryListeners = new Set<() => void>();

  constructor() {
    this.synchronizer = new StorageSynchronizer();
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

  async init({ type }: { type: 'local' | 'opfs' | 'memory' }) {
    await this.synchronizer.withLock({
      fn: async () => {
        this.providerGeneration++;
        if (this.provider) this.emitRpcRegistryChange();
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
      },
      lockKey: SYNC_LOCK_KEY,
      ...this.getLockOptions({ source: 'init' }),
    });
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
    if (event.type === 'naidan_rpc_registry' || event.type === 'migration') this.emitRpcRegistryChange();
    this.synchronizer.notify({ event });
  }

  /** Observe both this page's changes and synchronization hints from other
   * pages. A hint requires reading storage; it never contains authority. */
  subscribeNaidanRpcRegistryChanges({ listener }: { listener(): void }): () => void {
    this.rpcRegistryListeners.add(listener);
    const unsubscribe = this.synchronizer.subscribe({
      listener: ({ event }) => {
        if (event.type === 'naidan_rpc_registry' || event.type === 'migration') {
          try {
            listener();
          } catch { /* Synchronization hints are observation only. */ }
        }
      },
    });
    return () => {
      this.rpcRegistryListeners.delete(listener); unsubscribe();
    };
  }

  private emitRpcRegistryChange(): void {
    for (const listener of this.rpcRegistryListeners) {
      try {
        listener();
      } catch { /* Observers cannot change a storage commit's outcome. */ }
    }
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
      await this.synchronizer.withLock({
        fn: async () => {
          const current = await this.loadHierarchy();
          const before = structuredClone(current);
          const updated = await updater({ current: current });
          await detachRemovedModelLaunchOwners({ provider: this.getProvider(), before, after: updated });
          await this.getProvider().saveHierarchy({ hierarchy: hierarchyToDto({ domain: updated }) });
        },
        lockKey: LOCK_METADATA,
        ...this.getLockOptions({ source: 'updateHierarchy' }),
      });
      this.notify({ event: { type: 'chat_meta_and_chat_group', timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'updateHierarchy' });
      throw e;
    }
  }

  /** An in-memory capability for an async operation, not a persisted identifier. */
  captureModelLaunchStorage(): () => boolean {
    const provider = this.getProvider();
    return () => provider === this.getProvider();
  }

  /** Replacing or restoring a provider invalidates queued editor writes even
   * when its storage type and underlying provider instance stay the same. */
  captureSettingsStorage(): () => boolean {
    const provider = this.getProvider(), generation = this.providerGeneration;
    return () => provider === this.getProvider() && generation === this.providerGeneration;
  }

  async updateSettingsForStorage({ isCurrent, updater }: {
    isCurrent(): boolean,
    updater({ current }: { current: Settings | null }): Settings | Promise<Settings>,
  }): Promise<'saved' | 'changed'> {
    try {
      const outcome = await this.synchronizer.withLock({
        fn: async () => {
          if (!isCurrent()) return 'changed' as const;
          const provider = this.getProvider();
          const current = await provider.loadSettings();
          if (!isCurrent()) return 'changed' as const;
          const updated = await updater({ current });
          if (!isCurrent()) return 'changed' as const;
          await provider.saveSettings({ settings: updated });
          return 'saved' as const;
        },
        lockKey: SYNC_LOCK_KEY,
        ...this.getLockOptions({ source: 'updateSettingsForStorage' }),
      });
      switch (outcome) {
      case 'saved': this.notify({ event: { type: 'settings', timestamp: Date.now() } }); return outcome;
      case 'changed': return outcome;
      default: { const exhaustive: never = outcome; throw new Error(String(exhaustive)); }
      }
    } catch (error) {
      await this.handleStorageError({ error, source: 'updateSettingsForStorage' }); throw error;
    }
  }

  /** Setup state is session-local; it is never part of stored Chat data. */
  getModelLaunch({ chatId }: { chatId: ChatId }) {
    return this.provider === null ? undefined : readModelLaunch({ provider: this.provider, chatId });
  }

  async restoreModelLaunch({ chatId, input, requestedVariant, target, signal }: { chatId: Parameters<typeof restoreModelLaunch>[0]['chatId'], input: Parameters<typeof restoreModelLaunch>[0]['input'], requestedVariant: Parameters<typeof restoreModelLaunch>[0]['requestedVariant'], target: Parameters<typeof restoreModelLaunch>[0]['target'], signal: AbortSignal }) {
    const provider = this.getProvider();
    return this.synchronizer.withLock({
      lockKey: LOCK_METADATA,
      fn: async () => {
        signal.throwIfAborted();
        if (provider !== this.getProvider()) return undefined;
        const restored = await restoreModelLaunch({ provider, chatId, input, requestedVariant, target });
        signal.throwIfAborted();
        return provider === this.getProvider() ? restored : undefined;
      },
    });
  }

  /** A launch never holds a storage lock across metadata or payload requests. */
  async prepareModelLaunchChat({ request, signal }: { request: ModelLaunchChatRequest, signal: AbortSignal }): Promise<Chat> {
    const provider = this.getProvider();
    if (this.currentType !== 'memory' && (typeof navigator === 'undefined' || !navigator.locks?.request)) throw new Error('Model launch requires storage locking');
    try {
      const chat = await this.synchronizer.withLock({
        lockKey: LOCK_METADATA,
        fn: () => this.synchronizer.withLock({
          lockKey: SYNC_LOCK_KEY,
          fn: () => this.synchronizer.withLock({
            lockKey: `${LOCK_CHAT_CONTENT_PREFIX}${idToRaw({ id: request.chatId })}`,
            fn: async () => {
              signal.throwIfAborted();
              if (provider !== this.getProvider()) throw new Error('Model launch storage changed');
              // Finish a started durable write sequence even if navigation changes.
              return prepareModelLaunchChat({ provider, request });
            },
          }),
        }),
      });
      this.notify({ event: { type: 'chat_meta_and_chat_group', timestamp: Date.now() } });
      return chat;
    } catch (error) {
      if (!signal.aborted) await this.handleStorageError({ error, source: 'prepareModelLaunchChat' });
      throw error;
    }
  }

  // --- Persistence Methods ---

  // Returning undefined is a conditional no-op, checked under the metadata lock.
  // In particular, delayed background work must never recreate a deleted chat.
  async updateChatMeta({ id, updater }: { id: ChatId, updater: ({ current }: { current: ChatMeta | null }) => ChatMeta | undefined | Promise<ChatMeta | undefined> }): Promise<void> {
    try {
      let written = false;
      await this.synchronizer.withLock({
        fn: async () => {
          const current = await this.loadChatMeta({ id });
          const updated = await updater({ current: current });
          if (updated === undefined) return;
          await this.getProvider().saveChatMeta({ meta: updated });
          written = true;
        },
        lockKey: LOCK_METADATA,
        ...this.getLockOptions({ source: 'updateChatMeta' }),
      });
      if (written) this.notify({ event: { type: 'chat_meta_and_chat_group', id: idToRaw({ id }), timestamp: Date.now() } });
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
      await this.synchronizer.withLock({
        fn: async () => {
          const current = await this.loadChatContent({ id });
          const updated = await updater({ current: current });
          await this.getProvider().saveChatContent({ id, content: updated });
        },
        lockKey: `${LOCK_CHAT_CONTENT_PREFIX}${idToRaw({ id })}`,
        ...this.getLockOptions({ source: 'updateChatContent' }),
      });
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
      await this.synchronizer.withLock({
        fn: async () => {
          await this.getProvider().deleteChat({ id });
        },
        lockKey: LOCK_METADATA,
        ...this.getLockOptions({ source: 'deleteChat' }),
      });
      this.notify({ event: { type: 'chat_meta_and_chat_group', id: idToRaw({ id }), timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'deleteChat' });
      throw e;
    }
  }

  async updateChatGroup({ id, updater }: { id: ChatGroupId, updater: ({ current }: { current: ChatGroup | null }) => ChatGroup | Promise<ChatGroup> }): Promise<void> {
    try {
      await this.synchronizer.withLock({
        fn: async () => {
          const current = await this.loadChatGroup({ id });
          const updated = await updater({ current: current });
          await this.getProvider().saveChatGroup({ chatGroup: updated });
        },
        lockKey: LOCK_METADATA,
        ...this.getLockOptions({ source: 'updateChatGroup' }),
      });
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
      await this.synchronizer.withLock({
        fn: async () => {
          await this.getProvider().deleteChatGroup({ id });
        },
        lockKey: LOCK_METADATA,
        ...this.getLockOptions({ source: 'deleteChatGroup' }),
      });
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

  private rpcRegistryPersistence(): NaidanRpcRegistryAccess['persistence'] {
    const type = this.getCurrentType();
    switch (type) {
    case 'local': case 'opfs': return 'durable';
    case 'memory': return 'session';
    default: { const exhaustive: never = type; throw new Error(String(exhaustive)); }
    }
  }

  async loadNaidanRpcRegistry(): Promise<NaidanRpcRegistrySnapshot> {
    return this.synchronizer.withLock({
      lockKey: SYNC_LOCK_KEY,
      fn: async () => readNaidanRpcRegistry({
        provider: this.getProvider(),
        providerGeneration: this.providerGeneration,
        persistence: this.rpcRegistryPersistence(),
      }),
    });
  }

  async updateNaidanRpcRegistry({ access, updater }: {
    access: NaidanRpcRegistryAccess,
    updater({ registrations }: { registrations: readonly NaidanRpcRegistration[] }): Promise<readonly NaidanRpcRegistration[]>,
  }): Promise<NaidanRpcRegistryAccess> {
    const persistence = this.rpcRegistryPersistence();
    switch (persistence) {
    case 'durable':
      if (typeof navigator === 'undefined' || !navigator.locks?.request) throw new Error('Saving RPC registrations requires Web Locks');
      break;
    case 'session': break;
    default: { const exhaustive: never = persistence; throw new Error(String(exhaustive)); }
    }
    const updated = await this.synchronizer.withLock({
      lockKey: SYNC_LOCK_KEY,
      fn: async () => {
        const provider = this.getProvider();
        const current = await readNaidanRpcRegistry({
          provider,
          providerGeneration: this.providerGeneration,
          persistence: this.rpcRegistryPersistence(),
        });
        if (!sameNaidanRpcRegistry({ left: access, right: current.access })) throw new Error('The RPC storage registry changed. Reload before saving.');
        const registrations = await updater({ registrations: current.registrations });
        return writeNaidanRpcRegistry({ provider, current, registrations });
      },
    });
    this.notify({ event: { type: 'naidan_rpc_registry', timestamp: Date.now() } });
    return updated;
  }

  /**
   * Performs an atomic update on the global settings.
   */
  async updateSettings({ updater }: { updater: ({ current }: { current: Settings | null }) => Settings | Promise<Settings> }): Promise<void> {
    try {
      await this.synchronizer.withLock({
        fn: async () => {
          const current = await this.loadSettings();
          const updated = await updater({ current: current });
          await this.getProvider().saveSettings({ settings: updated });
        },
        lockKey: SYNC_LOCK_KEY,
        ...this.getLockOptions({ source: 'updateSettings' }),
      });
      this.notify({ event: { type: 'settings', timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'updateSettings' });
      throw e;
    }
  }

  /** Model inventory may render before storage initialization. Registration
   * metadata is absent then; actual provider failures must remain observable. */
  async loadHostModelDirectories(): Promise<NonNullable<NonNullable<Settings['experimental']>['hostModelDirectories']>> {
    if (!this.provider) return [];
    return (await this.provider.loadSettings())?.experimental?.hostModelDirectories ?? [];
  }

  async loadSettings(): Promise<Settings | null> {
    return this.getProvider().loadSettings();
  }

  async clearAll(): Promise<void> {
    try {
      await this.synchronizer.withLock({
        fn: async () => {
          this.providerGeneration++;
          this.notify({ event: { type: 'naidan_rpc_registry', timestamp: Date.now() } });
          await this.getProvider().clearAll();
        },
        lockKey: SYNC_LOCK_KEY,
        ...this.getLockOptions({ source: 'clearAll' }),
      });
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
      await this.synchronizer.withLock({
        fn: async () => {
          await this.getProvider().saveFile({
            blob,
            binaryObjectId,
            name,
            mimeType: blob.type || undefined,
          });
        },
        lockKey: LOCK_METADATA,
        ...this.getLockOptions({ source: 'saveFile' }),
      });
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
      const provider = this.getProvider();
      await this.synchronizer.withLock({
        fn: async () => {
          await provider.deleteBinaryObject({ binaryObjectId });
        },
        lockKey: LOCK_METADATA,
        ...this.getLockOptions({ source: 'deleteBinaryObject' }),
      });
      this.notify({ event: { type: 'binary_objects', timestamp: Date.now() } });
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'deleteBinaryObject' });
      throw e;
    }
  }

  // --- Volume Management ---

  async saveImageGeneration({ record, files }: {
    record: ImageGenerationRecord,
    files: { binaryObjectId: BinaryObjectId, blob: Blob, name: string }[],
  }): Promise<void> {
    const writer = this.createImageGenerationHistoryWriter();
    return writer.save({ record, files });
  }

  /** Pin the binary provider and history directory before starting computation.
   * The returned writer owns persistence, not a component or current settings.
   * A removed/replaced directory is an error; retries must never recreate it. */
  createImageGenerationHistoryWriter() {
    const storageType = this.getCurrentType();
    switch (storageType) {
    case 'opfs': break;
    case 'local': case 'memory': throw new Error('Image generation history requires OPFS storage');
    default: { const exhaustive: never = storageType; throw new Error(String(exhaustive)); }
    }
    const provider = this.getProvider();
    const historyModule = import('./image-generation-history');
    const target = historyModule.then(service => service.captureImageGenerationHistoryTarget({ storageType }));
    // Preparing a writer need not await storage before the caller can retain
    // pixels. A failed open remains a rejected target, never a silent new store.
    void target.catch(() => {});
    return {
      ready: async (): Promise<void> => {
        await target;
      },
      save: async ({ record, files }: {
      record: ImageGenerationRecord,
      files: { binaryObjectId: BinaryObjectId, blob: Blob, name: string }[],
    }): Promise<void> => {
        // Capture the provider before awaiting. A storage switch must not split
        // one generation's bytes between OPFS and another storage provider.
        const snapshot = imageGenerationToDomain({ dto: ExperimentalImageGenerationSchemaDto.parse(imageGenerationToDto({ record })) });
        const images = files.map(file => ({ ...file }));
        const { saveImageGenerationRecord } = await historyModule;
        const expectedDirectory = await target;
        await this.synchronizer.withLock({
          lockKey: LOCK_METADATA,
          ...this.getLockOptions({ source: 'saveImageGeneration' }),
          fn: () => saveImageGenerationRecord({
            storageType,
            expectedDirectory,
            record: snapshot,
            writeImages: async () => {
              const referenced = new Set([
                snapshot.result.binaryObjectId,
                ...snapshot.previews.map(image => image.binaryObjectId),
                ...(snapshot.request.imageInputs.initImage ? [snapshot.request.imageInputs.initImage.binaryObjectId] : []),
                ...snapshot.request.imageInputs.referenceImages.map(image => image.binaryObjectId),
              ].map(binaryObjectId => idToRaw({ id: binaryObjectId })));
              const supplied = new Set<string>();
              for (const image of images) {
                const rawId = idToRaw({ id: image.binaryObjectId });
                if (supplied.has(rawId) || !referenced.has(rawId)) throw new Error('Image history files must match unique record references');
                supplied.add(rawId);
              }
              for (const { binaryObjectId, blob, name } of images) {
                const metadata = await provider.getBinaryObject({ binaryObjectId });
                const existing = await provider.getFile({ binaryObjectId });
                if (metadata && !existing) throw new Error('Image history binary object is missing or unreadable');
                if (existing) {
                  if (existing.size !== blob.size || metadata && existing.type !== blob.type) throw new Error('Image history binary objects are immutable');
                  for (let offset = 0; offset < blob.size; offset += 65536) {
                    const left = new Uint8Array(await existing.slice(offset, offset + 65536).arrayBuffer());
                    const right = new Uint8Array(await blob.slice(offset, offset + 65536).arrayBuffer());
                    if (left.some((byte, index) => byte !== right[index])) throw new Error('Image history binary objects are immutable');
                  }
                }
                if (!existing || !metadata) {
                  await provider.saveFile({ binaryObjectId, blob, name, mimeType: blob.type || undefined });
                }
              }
              for (const rawId of referenced) {
                if (!await provider.getFile({ binaryObjectId: toBinaryObjectId({ raw: rawId }) })) throw new Error('Image history references a missing binary object');
              }
            },
          }),
        });
      },
    };
  }

  /** Pin binary publication and metadata to one store. Never call saveFile from
   * the inner Workspace callback: that would recursively acquire LOCK_METADATA. */
  async publishImageGeneration({ store, publication, files }: {
    store: ImageGenerationStoreAccess,
    publication:
      | { type: 'run', run: ImageGenerationRun }
      | { type: 'asset', asset: ImageGenerationAsset }
      | { type: 'draft', draft: ImageGenerationSessionDraft, expectedRevision: number | undefined },
    files: ImageGenerationBinaryFile[],
  }): Promise<void> {
    if (this.getCurrentType() !== 'opfs' || store.storageType !== 'opfs') throw new Error('Image Generation requires the original OPFS storage provider.');
    const provider = this.getProvider();
    const accepted = (() => {
      switch (publication.type) {
      case 'run': case 'asset': return structuredClone(publication);
      case 'draft': return {
        ...publication,
        draft: imageGenerationDraftToDomain({
          dto: ExperimentalImageGenerationDraftSchemaDto.parse(imageGenerationDraftToDto({ draft: publication.draft })),
        }),
      };
      default: { const exhaustive: never = publication; throw new Error(String(exhaustive)); }
      }
    })();
    const images = files.map(file => ({ ...file }));
    const service = await import('./image-generation');
    const { publishImageGenerationBinaries } = await import('./image-generation-binaries');
    const referenced = (() => {
      switch (accepted.type) {
      case 'asset': return [accepted.asset.result.binaryObjectId, ...accepted.asset.previews.map(image => image.binaryObjectId)];
      case 'run': {
        const inputs = accepted.run.request.imageInputs;
        return [...(inputs.initImage ? [inputs.initImage.binaryObjectId] : []), ...inputs.referenceImages.map(image => image.binaryObjectId)];
      }
      case 'draft': {
        const inputs = accepted.draft.request.imageInputs;
        return [...(inputs.initImage ? [inputs.initImage.binaryObjectId] : []), ...inputs.referenceImages.map(image => image.binaryObjectId)];
      }
      default: { const exhaustive: never = accepted; throw new Error(String(exhaustive)); }
      }
    })();
    const write = () => publishImageGenerationBinaries({ provider, referenced, files: images });
    await this.synchronizer.withLock({
      lockKey: LOCK_METADATA,
      ...this.getLockOptions({ source: 'publishImageGeneration' }),
      fn: async () => {
      // A queued callback must not publish through a provider that was replaced
      // before it acquired its lock. Once started, write uses only this provider.
        if (this.getProvider() !== provider) throw new Error('Image Generation storage changed before publication.');
        switch (accepted.type) {
        case 'run': return service.createImageGenerationRun({ store, run: accepted.run, writeInputs: write });
        case 'asset': return service.commitImageGenerationAsset({ store, asset: accepted.asset, writeImages: write });
        case 'draft': return service.saveImageGenerationDraft({ store, draft: accepted.draft, expectedRevision: accepted.expectedRevision, writeInputs: write });
        default: { const exhaustive: never = accepted; throw new Error(String(exhaustive)); }
        }
      },
    });
  }

  async deleteImageGenerationOutput({ store, sessionId, assetId, expectedRevision }: {
    store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, assetId: import('@/01-models/ids').ImageGenerationAssetId, expectedRevision: number,
  }): Promise<void> {
    if (this.getCurrentType() !== 'opfs' || store.storageType !== 'opfs') throw new Error('Image Generation deletion requires the original OPFS provider.');
    const provider = this.getProvider();
    const { deleteImageGenerationAsset } = await import('./image-generation-curation');
    try {
      await this.synchronizer.withLock({
        lockKey: LOCK_METADATA,
        ...this.getLockOptions({ source: 'deleteImageGenerationOutput' }),
        fn: async () => {
          if (this.getProvider() !== provider) throw new Error('The storage provider changed before deletion.');
          await deleteImageGenerationAsset({ store, sessionId, assetId, expectedRevision, removeBinary: ({ binaryObjectId }) => provider.deleteBinaryObject({ binaryObjectId }) });
        },
      });
    } finally {
      // Notify even on partial failure: completed byte removals are irreversible.
      this.notify({ event: { type: 'binary_objects', timestamp: Date.now() } });
    }
  }

  async captureImageGenerationExport({ store, sessionId }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId }): Promise<ImageGenerationExportSnapshot> {
    if (this.getCurrentType() !== 'opfs' || store.storageType !== 'opfs') throw new Error('Image Generation export requires OPFS.');
    const provider = this.getProvider();
    const { collectImageGenerationSessionMetadata } = await import('./image-generation-export');
    return this.synchronizer.withLock({
      lockKey: LOCK_METADATA,
      ...this.getLockOptions({ source: 'captureImageGenerationExport' }),
      fn: async () => {
        if (this.getProvider() !== provider) throw new Error('The storage provider changed before export.');
        const { metadata, binaryObjectIds } = await collectImageGenerationSessionMetadata({ store, sessionId });
        const binaries: ImageGenerationExportSnapshot['binaries'] = [];
        for (const id of binaryObjectIds) {
          const blob = await provider.getFile({ binaryObjectId: id });
          if (!blob) throw new Error(`A referenced image is missing: ${idToRaw({ id })}`);
          binaries.push({ id, blob });
        }
        return { metadata, binaries };
      },
    });
  }

  async loadImageGeneration({ id }: { id: ImageGenerationId }): Promise<ImageGenerationRecord | undefined> {
    const { loadImageGenerationRecord } = await import('./image-generation-history');
    return loadImageGenerationRecord({ storageType: this.getCurrentType(), id });
  }

  async deleteImageGeneration({ id }: { id: ImageGenerationId }): Promise<void> {
    const { deleteImageGenerationRecord } = await import('./image-generation-history');
    return deleteImageGenerationRecord({ storageType: this.getCurrentType(), id });
  }

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

  async getVolumeDirectoryHandle({ volumeId }: { volumeId: VolumeId }): Promise<FileSystemDirectoryHandle | null> {
    return this.getProvider().getVolumeDirectoryHandle({ volumeId });
  }

  async deleteVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    return this.getProvider().deleteVolume({ volumeId });
  }

  async deleteVolumeIfEmptyAndUnreferenced({ volumeId }: { volumeId: VolumeId }): Promise<'deleted' | 'kept'> {
    const isDirectoryEmpty = async ({ handle }: { handle: FileSystemDirectoryHandle }): Promise<boolean> => {
      for await (const _entry of handle.values()) {
        return false;
      }
      return true;
    };
    const isReferenced = async (): Promise<boolean> => (
      await this.getProvider().hasVolumeMountReference({ volumeId })
    );

    const handle = await this.getProvider().getVolumeDirectoryHandle({ volumeId });
    if (handle === null || !await isDirectoryEmpty({ handle })) return 'kept';
    if (await isReferenced()) return 'kept';

    return await this.synchronizer.withLock({
      // This runs from best-effort idle cleanup, so keep lock waiting/slow-path
      // notifications silent rather than surfacing background GC activity to the user.
      lockKey: LOCK_METADATA,
      fn: async () => await this.synchronizer.withLock({
        lockKey: SYNC_LOCK_KEY,
        fn: async () => {
          const latestHandle = await this.getProvider().getVolumeDirectoryHandle({ volumeId });
          if (latestHandle === null || !await isDirectoryEmpty({ handle: latestHandle })) return 'kept';
          if (await isReferenced()) return 'kept';

          await this.getProvider().deleteVolume({ volumeId });
          return 'deleted';
        },
      }),
    });
  }

  async renameVolume({ volumeId, name }: { volumeId: VolumeId, name: string }): Promise<void> {
    return this.getProvider().renameVolume({ volumeId, name });
  }

  async mountVolume({ volumeId, mountPath, readOnly }: {
    volumeId: VolumeId,
    mountPath: string,
    readOnly: boolean,
  }): Promise<void> {
    await this.updateSettings({
      updater: ({ current: settings }) => {
        if (!settings) throw new Error('Settings not initialized');
        const exists = settings.mounts.some(m => m.type === 'volume' && m.volumeId === volumeId);
        if (exists) return settings;

        return {
          ...settings,
          mounts: [...settings.mounts, { type: 'volume', volumeId, mountPath, readOnly }],
        };
      },
    });
  }

  async unmountVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
    await this.updateSettings({
      updater: ({ current: settings }) => {
        if (!settings) return null as unknown as Settings;
        return {
          ...settings,
          mounts: settings.mounts.filter(m => !(m.type === 'volume' && m.volumeId === volumeId)),
        };
      },
    });
  }

  async addMountToChat({ chatId, mount }: { chatId: ChatId, mount: Mount }): Promise<void> {
    await this.updateChatMeta({
      id: chatId,
      updater: ({ current }) => {
        if (!current) throw new Error(`Chat not found: ${idToRaw({ id: chatId })}`);
        const existing = current.mounts ?? [];
        return { ...current, mounts: [...existing, mount] };
      },
    });
  }

  async addMountToChatIfPathAvailable({ chatId, mount }: { chatId: ChatId, mount: Mount }): Promise<'added' | 'path_occupied'> {
    try {
      const result = await this.synchronizer.withLock({
        lockKey: LOCK_METADATA,
        ...this.getLockOptions({ source: 'addMountToChatIfPathAvailable' }),
        fn: async () => await this.synchronizer.withLock({
          lockKey: SYNC_LOCK_KEY,
          ...this.getLockOptions({ source: 'addMountToChatIfPathAvailable' }),
          fn: async (): Promise<'added' | 'path_occupied'> => {
            const provider = this.getProvider();
            const current = await provider.loadChatMeta({ id: chatId });
            if (!current) throw new Error(`Chat not found: ${idToRaw({ id: chatId })}`);

            const settings = await provider.loadSettings();
            if (settings?.mounts.some(existing => mountPathsAreEquivalent({ left: existing.mountPath, right: mount.mountPath }))) return 'path_occupied';

            const groupId = current.groupId ?? undefined;
            if (groupId !== undefined) {
              const group = await provider.loadChatGroup({ id: groupId });
              if (group?.mounts?.some(existing => mountPathsAreEquivalent({ left: existing.mountPath, right: mount.mountPath }))) return 'path_occupied';
            }

            const chatMounts = current.mounts ?? [];
            if (chatMounts.some(existing => mountPathsAreEquivalent({ left: existing.mountPath, right: mount.mountPath }))) return 'path_occupied';

            await provider.saveChatMeta({ meta: { ...current, mounts: [...chatMounts, mount] } });
            return 'added';
          },
        }),
      });
      switch (result) {
      case 'added':
        this.notify({ event: { type: 'chat_meta_and_chat_group', id: idToRaw({ id: chatId }), timestamp: Date.now() } });
        break;
      case 'path_occupied':
        break;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled chat mount result: ${String(_ex)}`);
      }
      }
      return result;
    } catch (e) {
      await this.handleStorageError({ error: e, source: 'addMountToChatIfPathAvailable' });
      throw e;
    }
  }

  async removeMountFromChat({ chatId, volumeId }: { chatId: ChatId, volumeId: VolumeId }): Promise<void> {
    await this.updateChatMeta({
      id: chatId,
      updater: ({ current }) => {
        if (!current) throw new Error(`Chat not found: ${idToRaw({ id: chatId })}`);
        return {
          ...current,
          mounts: (current.mounts ?? []).filter(m => !(m.type === 'volume' && m.volumeId === volumeId)),
        };
      },
    });
  }

  async updateChatMount({ chatId, volumeId, readOnly }: { chatId: ChatId, volumeId: VolumeId, readOnly: boolean }): Promise<void> {
    await this.updateChatMeta({
      id: chatId,
      updater: ({ current }) => {
        if (!current) throw new Error(`Chat not found: ${idToRaw({ id: chatId })}`);
        return {
          ...current,
          mounts: (current.mounts ?? []).map(m =>
            m.type === 'volume' && m.volumeId === volumeId ? { ...m, readOnly } : m,
          ),
        };
      },
    });
  }

  async addMountToChatGroup({ groupId, mount }: { groupId: ChatGroupId, mount: Mount }): Promise<void> {
    await this.updateChatGroup({
      id: groupId,
      updater: ({ current }) => {
        if (!current) throw new Error(`Chat group not found: ${idToRaw({ id: groupId })}`);
        const existing = current.mounts ?? [];
        return { ...current, mounts: [...existing, mount] };
      },
    });
  }

  async removeMountFromChatGroup({ groupId, volumeId }: { groupId: ChatGroupId, volumeId: VolumeId }): Promise<void> {
    await this.updateChatGroup({
      id: groupId,
      updater: ({ current }) => {
        if (!current) throw new Error(`Chat group not found: ${idToRaw({ id: groupId })}`);
        return {
          ...current,
          mounts: (current.mounts ?? []).filter(m => !(m.type === 'volume' && m.volumeId === volumeId)),
        };
      },
    });
  }

  async updateChatGroupMount({ groupId, volumeId, mountPath, readOnly }: { groupId: ChatGroupId, volumeId: VolumeId, mountPath: string, readOnly: boolean }): Promise<void> {
    await this.updateChatGroup({
      id: groupId,
      updater: ({ current }) => {
        if (!current) throw new Error(`Chat group not found: ${idToRaw({ id: groupId })}`);
        return {
          ...current,
          mounts: (current.mounts ?? []).map(m =>
            m.type === 'volume' && m.volumeId === volumeId ? { ...m, mountPath, readOnly } : m,
          ),
        };
      },
    });
  }

  async switchProvider({ type }: { type: 'local' | 'opfs' | 'memory' }) {
    try {
      await this.synchronizer.withLock({
        fn: async () => {
          const activeProvider = this.getProvider();
          if (this.currentType === type) return;

          const oldProvider = activeProvider;
          const rpcRegistry = await oldProvider.loadNaidanRpcRegistry();
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
                  for (const part of iterateAttachmentParts({ nodes: chat.root.items })) {
                    const att = part.attachment;
                    switch (att.status) {
                    case 'memory':
                      if (att.blob) {
                        rescued.push({
                          type: 'binary_object',
                          id: idToRaw({ id: att.binaryObjectId }),
                          name: att.originalName,
                          mimeType: att.mimeType,
                          size: att.size,
                          createdAt: att.uploadedAt,
                          blob: att.blob,
                        });
                        const { blob: _blob, ...persisted } = att;
                        part.attachment = { ...persisted, status: 'persisted' };
                      }
                      break;
                    case 'persisted':
                    case 'missing':
                      break;
                    default: {
                      const _ex: never = att;
                      throw new Error(`Unhandled attachment status: ${_ex}`);
                    }
                    }
                  }
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

          await newProvider.restore({
            snapshot: {
              structure: snapshot.structure,
              contentStream: migrationStream(),
            },
          });
          // Transfer local trust only during an explicit provider switch. It is
          // absent from general JSON backups, which cannot carry CryptoKey.
          await newProvider.saveNaidanRpcRegistry({ registry: rpcRegistry });
          const actualType = type === 'opfs' && !isOPFSSupported ? 'local' : type;

          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_BOOTSTRAP_KEY, actualType);
          }
          this.provider = newProvider;
          this.currentType = actualType;
          this.providerGeneration++;
        },
        lockKey: SYNC_LOCK_KEY,
        ...this.getLockOptions({ source: 'switchProvider', custom: { notifyLockWaitAfterMs: 5000 } }),
      });

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
      await this.synchronizer.withLock({
        fn: async () => {
          this.providerGeneration++;
          this.notify({ event: { type: 'naidan_rpc_registry', timestamp: Date.now() } });
          await this.getProvider().restore({ snapshot });
        },
        lockKey: SYNC_LOCK_KEY,
        ...this.getLockOptions({ source: 'restore', custom: { notifyLockWaitAfterMs: 5000 } }),
      });
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
