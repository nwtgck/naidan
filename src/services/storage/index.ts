import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, ChatMeta, ChatContent, Hierarchy, MessageNode, StorageSnapshot, BinaryObject, Volume, VolumeType, Mount } from '@/models/types';
import type { IStorageProvider } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { MemoryStorageProvider } from './memory-storage';
import { checkOPFSSupport } from './opfs-detection';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { STORAGE_BOOTSTRAP_KEY, SYNC_LOCK_KEY, LOCK_METADATA, LOCK_CHAT_CONTENT_PREFIX } from '@/models/constants';
import { chatToDto, hierarchyToDomain, hierarchyToDto } from '@/models/mappers';
import type { MigrationChunkDto } from '@/models/dto';
import type { BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/models/ids';
import { StorageSynchronizer, type ChangeListener, type StorageChangeEvent } from './synchronizer';
import { idToRaw, toChatId } from '@/models/ids';


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
      this.handleStorageError({ error: e, source: 'updateHierarchy' });
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
      this.handleStorageError({ error: e, source: 'updateChatMeta' });
      throw e;
    }
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    return this.getProvider().loadChatMeta({ id });
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return this.getProvider().loadChatContent({ id });
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
      this.handleStorageError({ error: e, source: 'updateChatContent' });
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
      this.handleStorageError({ error: e, source: 'deleteChat' });
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
      this.handleStorageError({ error: e, source: 'updateChatGroup' });
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
      this.handleStorageError({ error: e, source: 'deleteChatGroup' });
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
      this.handleStorageError({ error: e, source: 'updateSettings' });
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
      this.handleStorageError({ error: e, source: 'clearAll' });
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
      this.handleStorageError({ error: e, source: 'saveFile' });
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
      this.handleStorageError({ error: e, source: 'deleteBinaryObject' });
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

  async getVolumeDirectoryHandle({ volumeId }: { volumeId: VolumeId }): Promise<FileSystemDirectoryHandle | null> {
    return this.getProvider().getVolumeDirectoryHandle({ volumeId });
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
        if (this.currentType === type) return;

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

        const oldType = this.currentType;
        this.provider = newProvider;
        this.currentType = type;

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
                              mimeType: att.mimeType,
                              size: att.size,
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

        try {
          await newProvider.restore({ snapshot: {
            structure: snapshot.structure,
            contentStream: migrationStream(),
          } });
        } catch (e) {
          this.provider = oldProvider;
          this.currentType = oldType;
          throw e;
        }

        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(STORAGE_BOOTSTRAP_KEY, type);
        }
      }, lockKey: SYNC_LOCK_KEY, ...this.getLockOptions({ source: 'switchProvider', custom: { notifyLockWaitAfterMs: 5000 } }) });

      this.notify({ event: { type: 'migration', timestamp: Date.now() } });
    } catch (e) {
      this.handleStorageError({ error: e, source: 'switchProvider' });
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
      this.handleStorageError({ error: e, source: 'restore' });
      throw e;
    }
  }

  private getLockOptions({ source, custom = {} }: { source: string, custom?: { notifyLockWaitAfterMs?: number } }) {
    return {
      ...custom,
      onLockWait: () => {
        const { addInfoEvent } = useGlobalEvents();
        addInfoEvent({
          source: `StorageService:${source}`,
          message: 'Storage is busy. Waiting for other tabs to finish...',
        });
      },
      onTaskSlow: () => {
        const { addInfoEvent } = useGlobalEvents();
        addInfoEvent({
          source: `StorageService:${source}`,
          message: 'Storage operation is taking longer than expected...',
        });
      },
      onFinalize: () => {
        const { addInfoEvent } = useGlobalEvents();
        addInfoEvent({
          source: `StorageService:${source}`,
          message: 'Storage operation completed.',
        });
      },
    };
  }

  private handleStorageError({ error, source }: { error: unknown, source: string }) {
    const { addErrorEvent } = useGlobalEvents();
    addErrorEvent({
      source: `StorageService:${source}`,
      message: 'An error occurred during a storage operation.',
      details: error instanceof Error ? error : String(error),
    });
  }
}

export const storageService = new StorageService();
export type { ChatSummary };
