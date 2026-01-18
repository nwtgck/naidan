import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, MessageNode } from '../../models/types';
import type { IStorageProvider } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { checkOPFSSupport } from './opfs-detection';
import { useGlobalEvents } from '../../composables/useGlobalEvents';
import { STORAGE_BOOTSTRAP_KEY } from '../../models/constants';
import { chatToDto } from '../../models/mappers';
import type { MigrationChunkDto } from '../../models/dto';
import { StorageSynchronizer, type ChangeListener } from './synchronizer';

export class StorageService {
  private provider: IStorageProvider | null = null;
  private currentType: 'local' | 'opfs' | null = null;
  private synchronizer: StorageSynchronizer;

  constructor() {
    this.synchronizer = new StorageSynchronizer();
  }

  /**
   * Returns the current storage provider.
   * 
   * WARNING: This method returns the raw provider WITHOUT any locking or 
   * concurrency protection. Calling methods directly on the provider is 
   * NOT thread-safe and can lead to data corruption or race conditions.
   * Use the public methods of StorageService instead, as they are guarded 
   * by the synchronizer.
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

    // Fallback if OPFS is requested but not available in this environment
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

  // --- Migration ---

  async switchProvider(type: 'local' | 'opfs') {
    // We lock the entire migration process to prevent race conditions
    // Using a longer timeout (60s) for migration as it involves data transfer
    try {
      await this.synchronizer.withLock(async () => {
        const activeProvider = this.getProvider();
        if (this.currentType === type) return;

        const oldProvider = activeProvider;
        let newProvider: IStorageProvider;

        // Initialize the target provider
        if (type === 'opfs' && await checkOPFSSupport()) {
          newProvider = new OPFSStorageProvider();
        } else {
          newProvider = new LocalStorageProvider();
        }

        try {
          await newProvider.init();
          
          // Migrate data: Dump from old -> Restore to new
          console.log(`Migrating data from ${this.currentType} to ${type}...`);
          
          // Define a wrapper generator to inject memory blobs if we're moving from Local to OPFS
          async function* migrationStream(): AsyncGenerator<MigrationChunkDto> {
            for await (const chunk of oldProvider.dump()) {
              if (chunk.type === 'chat' && newProvider.canPersistBinary) {
                const rescuedAttachments: MigrationChunkDto[] = [];

                // We MUST use the domain object to get the BLOBS, because DTOs don't have them
                // We use oldProvider directly to be sure we get the correct data
                const chat = await oldProvider.loadChat(chunk.data.id);
                if (!chat) {
                  yield chunk;
                  continue;
                }

                const findAndRescueBlobs = (nodes: MessageNode[]) => {
                  for (const node of nodes) {
                    if (node.attachments) {
                      for (let i = 0; i < node.attachments.length; i++) {
                        const att = node.attachments[i];
                        if (att && att.status === 'memory' && 'blob' in att && att.blob) {
                          rescuedAttachments.push({
                            type: 'attachment',
                            chatId: chat.id,
                            attachmentId: att.id,
                            originalName: att.originalName,
                            mimeType: att.mimeType,
                            size: att.size,
                            uploadedAt: att.uploadedAt,
                            blob: att.blob
                          });
                          // Replace with persisted version
                          node.attachments[i] = {
                            id: att.id,
                            originalName: att.originalName,
                            mimeType: att.mimeType,
                            size: att.size,
                            uploadedAt: att.uploadedAt,
                            status: 'persisted'
                          };
                        }
                      }
                    }
                    if (node.replies?.items) {
                      findAndRescueBlobs(node.replies.items);
                    }
                  }
                };

                findAndRescueBlobs(chat.root.items);

                // Yield rescued attachments FIRST
                for (const attChunk of rescuedAttachments) {
                  yield attChunk;
                }
                
                // Yield the updated chat (converted back to DTO with 'persisted' status) AFTER
                yield { type: 'chat', data: chatToDto(chat, chunk.data.order ?? 0) };
              } else {
                yield chunk;
              }
            }
          }

          // We temporary switch provider so restore() works correctly if it relies on instance methods
          const oldType = this.currentType;
          this.provider = newProvider;
          this.currentType = type;

          try {
            await newProvider.restore(migrationStream());
          } catch (e) {
            // Rollback
            this.provider = oldProvider;
            this.currentType = oldType;
            throw e;
          }
          
          // Persist active storage type for the next application load
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(STORAGE_BOOTSTRAP_KEY, type);
          }

          console.log('Storage migration completed successfully.');
        } catch (error) {
          console.error('Storage migration failed. Reverting to previous provider.', error);
          throw error; 
        }
      }, { timeoutMs: 60000 });

      // Notify others that a migration happened (they should reload everything)
      this.synchronizer.notify('migration');
    } catch (e) {
      this.handleStorageError(e, 'switchProvider');
      throw e;
    }
  }

  // --- Domain Methods (leveraging base class implementations) ---

  async listChats(): Promise<ChatSummary[]> {
    return this.getProvider().listChats();
  }

  async listChatGroups(): Promise<ChatGroup[]> {
    return this.getProvider().listChatGroups();
  }

  async getSidebarStructure(): Promise<SidebarItem[]> {
    return this.getProvider().getSidebarStructure();
  }

  // --- Persistence Methods (Guarded by Locks) ---

  async saveChat(chat: Chat, index: number): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().saveChat(chat, index);
      });
      this.synchronizer.notify('chat', chat.id);
    } catch (e) {
      this.handleStorageError(e, 'saveChat');
      throw e;
    }
  }

  async loadChat(id: string): Promise<Chat | null> {
    // Reads don't strictly need locks for consistency in this model 
    // as long as writes are atomic.
    return this.getProvider().loadChat(id);
  }

  async deleteChat(id: string): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().deleteChat(id);
      });
      this.synchronizer.notify('chat', id);
    } catch (e) {
      this.handleStorageError(e, 'deleteChat');
      throw e;
    }
  }

  async saveChatGroup(chatGroup: ChatGroup, index: number): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().saveChatGroup(chatGroup, index);
      });
      this.synchronizer.notify('chat_group', chatGroup.id);
    } catch (e) {
      this.handleStorageError(e, 'saveChatGroup');
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
      });
      this.synchronizer.notify('chat_group', id);
    } catch (e) {
      this.handleStorageError(e, 'deleteChatGroup');
      throw e;
    }
  }

  async saveSettings(settings: Settings): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().saveSettings(settings);
      });
      this.synchronizer.notify('settings');
    } catch (e) {
      this.handleStorageError(e, 'saveSettings');
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
      });
      this.synchronizer.notify('migration'); // Treat as migration (full reset)
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
      });
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

  // --- Bulk Operations (Migration / Backup) ---

  /**
   * Dumps the entire storage content.
   * WARNING: This generator does not hold a global lock while yielding to allow
   * for memory-efficient streaming. For a consistent snapshot, the caller
   * should ensure no concurrent writes are happening.
   */
  dumpWithoutLock(): AsyncGenerator<MigrationChunkDto> {
    return this.getProvider().dump();
  }

  /**
   * Restores storage content from a stream.
   * This operation is guarded by an exclusive lock as it is destructive.
   */
  async restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void> {
    try {
      await this.synchronizer.withLock(async () => {
        await this.getProvider().restore(stream);
      }, { timeoutMs: 60000 });
      this.synchronizer.notify('migration');
    } catch (e) {
      this.handleStorageError(e, 'restore');
      throw e;
    }
  }

  private handleStorageError(e: unknown, source: string) {
    const { addErrorEvent } = useGlobalEvents();
    const isTimeout = e instanceof Error && e.message.includes('Lock acquisition timed out');
    
    addErrorEvent({
      source: `StorageService:${source}`,
      message: isTimeout 
        ? 'Storage operation timed out. Another tab might be performing a long operation.' 
        : 'An error occurred during a storage operation.',
      details: e instanceof Error ? e : String(e),
    });
  }
}

export const storageService = new StorageService();
export type { ChatSummary };
