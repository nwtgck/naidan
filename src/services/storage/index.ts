import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, MessageNode } from '../../models/types';
import type { IStorageProvider } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { checkOPFSSupport } from './opfs-detection';
import { useGlobalEvents } from '../../composables/useGlobalEvents';
import { STORAGE_BOOTSTRAP_KEY } from '../../models/constants';
import { chatToDto } from '../../models/mappers';
import type { MigrationChunkDto } from '../../models/dto';

export class StorageService {
  private provider: IStorageProvider | null = null;
  private currentType: 'local' | 'opfs' | null = null;

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

  async switchProvider(type: 'local' | 'opfs') {
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
      
      const { addErrorEvent } = useGlobalEvents();
      addErrorEvent({
        source: 'StorageService',
        message: 'Storage migration failed. Reverting to previous provider.',
        details: error instanceof Error ? error : new Error(String(error)),
      });

      throw error; 
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

  // --- Persistence Methods ---

  async saveChat(chat: Chat, index: number): Promise<void> {
    return this.getProvider().saveChat(chat, index);
  }

  async loadChat(id: string): Promise<Chat | null> {
    return this.getProvider().loadChat(id);
  }

  async deleteChat(id: string): Promise<void> {
    return this.getProvider().deleteChat(id);
  }

  async saveChatGroup(chatGroup: ChatGroup, index: number): Promise<void> {
    return this.getProvider().saveChatGroup(chatGroup, index);
  }

  async loadChatGroup(id: string): Promise<ChatGroup | null> {
    return this.getProvider().loadChatGroup(id);
  }

  async deleteChatGroup(id: string): Promise<void> {
    return this.getProvider().deleteChatGroup(id);
  }

  async saveSettings(settings: Settings): Promise<void> {
    return this.getProvider().saveSettings(settings);
  }

  async loadSettings(): Promise<Settings | null> {
    return this.getProvider().loadSettings();
  }

  async clearAll(): Promise<void> {
    return this.getProvider().clearAll();
  }

  // --- File Storage Methods ---

  async saveFile(blob: Blob, attachmentId: string, originalName: string): Promise<void> {
    return this.getProvider().saveFile(blob, attachmentId, originalName);
  }

  async getFile(attachmentId: string, originalName: string): Promise<Blob | null> {
    return this.getProvider().getFile(attachmentId, originalName);
  }

  async hasAttachments(): Promise<boolean> {
    return this.getProvider().hasAttachments();
  }
}

export const storageService = new StorageService();
export type { ChatSummary };