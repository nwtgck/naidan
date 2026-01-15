import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, MessageNode } from '../../models/types';
import type { IStorageProvider } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { useGlobalEvents } from '../../composables/useGlobalEvents';
import { STORAGE_BOOTSTRAP_KEY } from '../../models/constants';
import { chatToDto } from '../../models/mappers';
import type { MigrationChunkDto } from '../../models/dto';

export class StorageService {
  private provider: IStorageProvider;
  private currentType: 'local' | 'opfs' = 'local';

  constructor() {
    this.provider = new LocalStorageProvider();
  }

  async init(type: 'local' | 'opfs' = 'local') {
    this.currentType = type;
    if (type === 'opfs' && typeof navigator.storage?.getDirectory === 'function') {
      this.provider = new OPFSStorageProvider();
    } else {
      this.provider = new LocalStorageProvider();
    }
    await this.provider.init();
  }

  getCurrentType(): 'local' | 'opfs' {
    return this.currentType;
  }

  get canPersistBinary(): boolean {
    return this.provider.canPersistBinary;
  }

  async switchProvider(type: 'local' | 'opfs') {
    if (this.currentType === type) return;

    const oldProvider = this.provider;
    let newProvider: IStorageProvider;

    // Initialize the target provider
    if (type === 'opfs' && typeof navigator.storage?.getDirectory === 'function') {
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
    return this.provider.listChats();
  }

  async listChatGroups(): Promise<ChatGroup[]> {
    return this.provider.listChatGroups();
  }

  async getSidebarStructure(): Promise<SidebarItem[]> {
    return this.provider.getSidebarStructure();
  }

  // --- Persistence Methods ---

  async saveChat(chat: Chat, index: number): Promise<void> {
    return this.provider.saveChat(chat, index);
  }

  async loadChat(id: string): Promise<Chat | null> {
    return this.provider.loadChat(id);
  }

  async deleteChat(id: string): Promise<void> {
    return this.provider.deleteChat(id);
  }

  async saveChatGroup(chatGroup: ChatGroup, index: number): Promise<void> {
    return this.provider.saveChatGroup(chatGroup, index);
  }

  async loadChatGroup(id: string): Promise<ChatGroup | null> {
    return this.provider.loadChatGroup(id);
  }

  async deleteChatGroup(id: string): Promise<void> {
    return this.provider.deleteChatGroup(id);
  }

  async saveSettings(settings: Settings): Promise<void> {
    return this.provider.saveSettings(settings);
  }

  async loadSettings(): Promise<Settings | null> {
    return this.provider.loadSettings();
  }

  async clearAll(): Promise<void> {
    return this.provider.clearAll();
  }

  // --- File Storage Methods ---

  async saveFile(blob: Blob, attachmentId: string, originalName: string): Promise<void> {
    return this.provider.saveFile(blob, attachmentId, originalName);
  }

  async getFile(attachmentId: string, originalName: string): Promise<Blob | null> {
    return this.provider.getFile(attachmentId, originalName);
  }

  async hasAttachments(): Promise<boolean> {
    return this.provider.hasAttachments();
  }
}

export const storageService = new StorageService();
export type { ChatSummary };