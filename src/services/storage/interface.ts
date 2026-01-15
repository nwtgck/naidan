import type { Chat, Settings, ChatGroup, ChatSummary, SidebarItem } from '../../models/types';
import type { ChatMetaDto, ChatGroupDto, MigrationChunkDto } from '../../models/dto';
import { buildSidebarItemsFromDtos } from '../../models/mappers';

export type { ChatSummary };

/**
 * Base Storage Provider
 * Provides common logic for transforming DTOs to Domain models.
 */
export abstract class IStorageProvider {
  abstract init(): Promise<void>;
  
  /**
   * Whether this provider supports efficient binary persistence (e.g. OPFS).
   * LocalStorage returns false to indicate potential capacity issues.
   */
  abstract readonly canPersistBinary: boolean;

  // --- Data Access Methods ---
  // Subclasses implement these to fetch raw DTOs.
  protected abstract listChatMetasRaw(): Promise<ChatMetaDto[]>;
  protected abstract listChatGroupsRaw(): Promise<ChatGroupDto[]>;

  // --- Bulk Operations (Migration) ---
  abstract dump(): AsyncGenerator<MigrationChunkDto>;
  abstract restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void>;

  // --- Public Domain API (Default Implementations) ---

  /**
   * Returns sorted ChatGroups with their nested items.
   */
  public async listChatGroups(): Promise<ChatGroup[]> {
    const sidebar = await this.getSidebarStructure();
    return sidebar
      .filter((item): item is Extract<SidebarItem, { type: 'chat_group' }> => item.type === 'chat_group')
      .map(item => item.chatGroup);
  }

  /**
   * Returns a flat list of all ChatSummaries, ordered by their sidebar position.
   */
  public async listChats(): Promise<ChatSummary[]> {
    const sidebar = await this.getSidebarStructure();
    const allSummaries: ChatSummary[] = [];
    
    sidebar.forEach(item => {
      if (item.type === 'chat_group') {
        item.chatGroup.items.forEach(nested => {
          if (nested.type === 'chat') allSummaries.push(nested.chat);
        });
      } else {
        allSummaries.push(item.chat);
      }
    });
    return allSummaries;
  }

  /**
   * Centralized method to get the full sorted hierarchy using mappers.
   */
  public async getSidebarStructure(): Promise<SidebarItem[]> {
    const [metas, chatGroups] = await Promise.all([
      this.listChatMetasRaw(),
      this.listChatGroupsRaw(),
    ]);
    return buildSidebarItemsFromDtos(chatGroups, metas);
  }

  // --- Persistence Methods ---
  
  abstract saveChat(chat: Chat, index: number): Promise<void>;
  abstract loadChat(id: string): Promise<Chat | null>;
  abstract deleteChat(id: string): Promise<void>;
  
  abstract saveChatGroup(chatGroup: ChatGroup, index: number): Promise<void>;
  abstract loadChatGroup(id: string): Promise<ChatGroup | null>;
  abstract deleteChatGroup(id: string): Promise<void>;
  
  abstract saveSettings(settings: Settings): Promise<void>;
  abstract loadSettings(): Promise<Settings | null>;
  abstract clearAll(): Promise<void>;

  // --- File Storage ---
  abstract saveFile(blob: Blob, attachmentId: string, originalName: string): Promise<void>;
  abstract getFile(attachmentId: string, originalName: string): Promise<Blob | null>;
  abstract hasAttachments(): Promise<boolean>;
}
