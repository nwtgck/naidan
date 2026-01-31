import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, ChatMeta, ChatContent, Hierarchy, MessageNode, StorageSnapshot } from '../../models/types';
import type { IStorageProvider } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { checkOPFSSupport } from './opfs-detection';
import { useGlobalEvents } from '../../composables/useGlobalEvents';
import { STORAGE_BOOTSTRAP_KEY, SYNC_LOCK_KEY, LOCK_METADATA, LOCK_CHAT_CONTENT_PREFIX } from '../../models/constants';
import { chatToDto, hierarchyToDomain, hierarchyToDto } from '../../models/mappers';
import type { MigrationChunkDto } from '../../models/dto';
import { StorageSynchronizer, type ChangeListener, type StorageChangeEvent } from './synchronizer';

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
  private currentType: 'local' | 'opfs' | null = null;
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

  async init(type: 'local' | 'opfs') {
    const isOPFSSupported = await checkOPFSSupport();
    let targetType: 'local' | 'opfs' = type;

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
    default: {
      const _exhaustiveCheck: never = this.currentType;
      throw new Error(`Unhandled currentType: ${_exhaustiveCheck}`);
    }
    }
    await this.provider.init();
  }

  getCurrentType(): 'local' | 'opfs' {
    if (!this.currentType) {
      throw new Error('StorageService not initialized. Call init() first.');
    }
    return this.currentType;
  }

  get canPersistBinary(): boolean {
    return this.getProvider().canPersistBinary;
  }

  // --- Synchronization ---

  subscribeToChanges(listener: ChangeListener) {
    return this.synchronizer.subscribe(listener);
  }

  notify(event: StorageChangeEvent): void;
  /**
   * @deprecated Use notify(event: StorageChangeEvent) instead.
   */
  notify(type: string, id?: string): void;
  notify(eventOrType: StorageChangeEvent | string, id?: string): void {
    const t = typeof eventOrType;
    switch (t) {
    case 'string':
      this.synchronizer.notify(eventOrType as string, id);
      break;
    case 'object':
      this.synchronizer.notify(eventOrType as StorageChangeEvent);
      break;
    case 'undefined':
    case 'boolean':
    case 'number':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new Error(`Unexpected event type: ${t}`);
    default: {
      const _ex: never = t;
      throw new Error(`Unhandled event type: ${_ex}`);
    }
    }
  }

  // --- Hierarchy Management (Atomic) ---

  async loadHierarchy(): Promise<Hierarchy> {
    const dto = await this.getProvider().loadHierarchy();
    return dto ? hierarchyToDomain(dto) : { items: [] };
  }

  /**
   * Performs an atomic update on the sidebar hierarchy.
   * Prevents lost updates when multiple tabs are reordering or adding chats.
   */
  async updateHierarchy(updater: (current: Hierarchy) => Hierarchy | Promise<Hierarchy>): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        const current = await this.loadHierarchy();
        const updated = await updater(current);
        await this.getProvider().saveHierarchy(hierarchyToDto(updated));
      }, { lockKey: LOCK_METADATA, ...this.getLockOptions('updateHierarchy') });
      this.synchronizer.notify('chat_meta_and_chat_group');
    } catch (e) {
      this.handleStorageError(e, 'updateHierarchy');
      throw e;
    }
  }

  // --- Persistence Methods ---

  async updateChatMeta(id: string, updater: (current: ChatMeta | null) => ChatMeta | Promise<ChatMeta>): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        const current = await this.loadChatMeta(id);
        const updated = await updater(current);
        await this.getProvider().saveChatMeta(updated);
      }, { lockKey: LOCK_METADATA, ...this.getLockOptions('updateChatMeta') });
      this.synchronizer.notify('chat_meta_and_chat_group', id);
    } catch (e) {
      this.handleStorageError(e, 'updateChatMeta');
      throw e;
    }
  }

  async loadChatMeta(id: string): Promise<ChatMeta | null> {
    return this.getProvider().loadChatMeta(id);
  }

  async loadChatContent(id: string): Promise<ChatContent | null> {
    return this.getProvider().loadChatContent(id);
  }

  async updateChatContent(id: string, updater: (current: ChatContent | null) => ChatContent | Promise<ChatContent>): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        const current = await this.loadChatContent(id);
        const updated = await updater(current);
        await this.getProvider().saveChatContent(id, updated);
      }, { lockKey: `${LOCK_CHAT_CONTENT_PREFIX}${id}`, ...this.getLockOptions('updateChatContent') });
      this.synchronizer.notify('chat_content', id);
    } catch (e) {
      this.handleStorageError(e, 'updateChatContent');
      throw e;
    }
  }

  async loadChat(id: string): Promise<Chat | null> {
    return this.getProvider().loadChat(id);
  }

  async deleteChat(id: string): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().deleteChat(id);
      }, { lockKey: LOCK_METADATA, ...this.getLockOptions('deleteChat') });
      this.synchronizer.notify('chat_meta_and_chat_group', id);
    } catch (e) {
      this.handleStorageError(e, 'deleteChat');
      throw e;
    }
  }

  async updateChatGroup(id: string, updater: (current: ChatGroup | null) => ChatGroup | Promise<ChatGroup>): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        const current = await this.loadChatGroup(id);
        const updated = await updater(current);
        await this.getProvider().saveChatGroup(updated);
      }, { lockKey: LOCK_METADATA, ...this.getLockOptions('updateChatGroup') });
      this.synchronizer.notify('chat_meta_and_chat_group', id);
    } catch (e) {
      this.handleStorageError(e, 'updateChatGroup');
      throw e;
    }
  }

  async loadChatGroup(id: string): Promise<ChatGroup | null> {
    return this.getProvider().loadChatGroup(id);
  }

  async deleteChatGroup(id: string): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().deleteChatGroup(id);
      }, { lockKey: LOCK_METADATA, ...this.getLockOptions('deleteChatGroup') });
      this.synchronizer.notify('chat_meta_and_chat_group', id);
    } catch (e) {
      this.handleStorageError(e, 'deleteChatGroup');
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
  async updateSettings(updater: (current: Settings | null) => Settings | Promise<Settings>): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        const current = await this.loadSettings();
        const updated = await updater(current);
        await this.getProvider().saveSettings(updated);
      }, { lockKey: SYNC_LOCK_KEY, ...this.getLockOptions('updateSettings') });
      this.synchronizer.notify('settings');
    } catch (e) {
      this.handleStorageError(e, 'updateSettings');
      throw e;
    }
  }

  async loadSettings(): Promise<Settings | null> {
    return this.getProvider().loadSettings();
  }

  async clearAll(): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().clearAll();
      }, { lockKey: SYNC_LOCK_KEY, ...this.getLockOptions('clearAll') });
      this.synchronizer.notify('migration');
    } catch (e) {
      this.handleStorageError(e, 'clearAll');
      throw e;
    }
  }

  // --- File Storage Methods ---

  async saveFile(blob: Blob, attachmentId: string, originalName: string): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().saveFile(blob, attachmentId, originalName);
      }, { lockKey: LOCK_METADATA, ...this.getLockOptions('saveFile') });
    } catch (e) {
      this.handleStorageError(e, 'saveFile');
      throw e;
    }
  }

  async getFile(attachmentId: string, originalName: string): Promise<Blob | null> {
    return this.getProvider().getFile(attachmentId, originalName);
  }

  async hasAttachments(): Promise<boolean> {
    return this.getProvider().hasAttachments();
  }

  async switchProvider(type: 'local' | 'opfs') {
    try {
      await this.synchronizer.withLock(async () => {
        const activeProvider = this.getProvider();
        if (this.currentType === type) return;

        const oldProvider = activeProvider;
        const snapshot = await oldProvider.dump();

        let newProvider: IStorageProvider;
        if (type === 'opfs' && await checkOPFSSupport()) {
          newProvider = new OPFSStorageProvider();
        } else {
          newProvider = new LocalStorageProvider();
        }

        await newProvider.init();
          
        const oldType = this.currentType;
        this.provider = newProvider;
        this.currentType = type;

        // Wrap content stream to rescue memory blobs
        const migrationStream = async function* (): AsyncGenerator<MigrationChunkDto> {
          for await (const chunk of snapshot.contentStream) {
            switch (chunk.type) {
            case 'chat':
              if (newProvider.canPersistBinary) {
                const chat = await oldProvider.loadChat(chunk.data.id);
                if (!chat) { yield chunk; continue; }

                const rescued: MigrationChunkDto[] = [];
                const findAndRescue = (nodes: MessageNode[]) => {
                  for (const node of nodes) {
                    if (node.attachments) {
                      for (let i = 0; i < node.attachments.length; i++) {
                        const att = node.attachments[i]!;
                        switch (att.status) {
                        case 'memory':
                          if (att.blob) {
                            rescued.push({
                              type: 'attachment',
                              chatId: chat.id,
                              attachmentId: att.id,
                              originalName: att.originalName,
                              mimeType: att.mimeType,
                              size: att.size,
                              uploadedAt: att.uploadedAt,
                              blob: att.blob
                            });
                            node.attachments[i] = { ...att, status: 'persisted' as const };
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
                    }
                    if (node.replies?.items) findAndRescue(node.replies.items);
                  }
                };
                findAndRescue(chat.root.items);
                for (const r of rescued) yield r;
                yield { type: 'chat', data: chatToDto(chat) };
              } else {
                yield chunk;
              }
              break;
            case 'attachment':
              yield chunk;
              break;
            default: {
              const _ex: never = chunk;
              throw new Error(`Unhandled migration chunk type: ${_ex}`);
            }
            }
          }
        };

        try {
          await newProvider.restore({
            structure: snapshot.structure,
            contentStream: migrationStream(),
          });
        } catch (e) {
          this.provider = oldProvider;
          this.currentType = oldType;
          throw e;
        }
          
        if ((() => {
          const t = typeof localStorage;
          switch (t) {
          case 'undefined': return false;
          case 'object':
          case 'boolean':
          case 'string':
          case 'number':
          case 'function':
          case 'symbol':
          case 'bigint':
            return true;
          default: {
            const _ex: never = t;
            return _ex;
          }
          }
        })()) {
          localStorage.setItem(STORAGE_BOOTSTRAP_KEY, type);
        }
      }, { lockKey: SYNC_LOCK_KEY, ...this.getLockOptions('switchProvider', { notifyLockWaitAfterMs: 5000 }) });

      this.synchronizer.notify('migration');
    } catch (e) {
      this.handleStorageError(e, 'switchProvider');
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
  async restore(snapshot: StorageSnapshot): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().restore(snapshot);
      }, { lockKey: SYNC_LOCK_KEY, ...this.getLockOptions('restore', { notifyLockWaitAfterMs: 5000 }) });
      this.synchronizer.notify('migration');
    } catch (e) {
      this.handleStorageError(e, 'restore');
      throw e;
    }
  }

  private getLockOptions(source: string, custom: { notifyLockWaitAfterMs?: number } = {}) {
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

  private handleStorageError(e: unknown, source: string) {
    const { addErrorEvent } = useGlobalEvents();
    addErrorEvent({
      source: `StorageService:${source}`,
      message: 'An error occurred during a storage operation.',
      details: e instanceof Error ? e : String(e),
    });
  }
}

export const storageService = new StorageService();
export type { ChatSummary };
