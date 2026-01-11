import type { Chat, Settings, ChatGroup, ChatSummary, SidebarItem } from '../../models/types';
import type { ChatDto, ChatGroupDto } from '../../models/dto';
import { buildSidebarItemsFromDtos } from '../../models/mappers';

export type { ChatSummary };

/**
 * Base Storage Provider
 * Provides common logic for transforming DTOs to Domain models.
 */
export abstract class IStorageProvider {
  abstract init(): Promise<void>;
  
  // --- Data Access Methods ---
  // Subclasses implement these to fetch raw DTOs.
  protected abstract listChatsRaw(): Promise<ChatDto[]>;
  protected abstract listGroupsRaw(): Promise<ChatGroupDto[]>;

  // --- Public Domain API (Default Implementations) ---

  /**
   * Returns sorted ChatGroups with their nested items.
   */
  public async listGroups(): Promise<ChatGroup[]> {
    const sidebar = await this.getSidebarStructure();
    return sidebar
      .filter((item): item is Extract<SidebarItem, { type: 'group' }> => item.type === 'group')
      .map(item => item.group);
  }

  /**
   * Returns a flat list of all ChatSummaries, ordered by their sidebar position.
   */
  public async listChats(): Promise<ChatSummary[]> {
    const sidebar = await this.getSidebarStructure();
    const allSummaries: ChatSummary[] = [];
    
    sidebar.forEach(item => {
      if (item.type === 'group') {
        item.group.items.forEach(nested => {
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
    const [chats, groups] = await Promise.all([
      this.listChatsRaw(),
      this.listGroupsRaw(),
    ]);
    return buildSidebarItemsFromDtos(groups, chats);
  }

  // --- Persistence Methods ---
  
  abstract saveChat(chat: Chat, index: number): Promise<void>;
  abstract loadChat(id: string): Promise<Chat | null>;
  abstract deleteChat(id: string): Promise<void>;
  
  abstract saveGroup(group: ChatGroup, index: number): Promise<void>;
  abstract loadGroup(id: string): Promise<ChatGroup | null>;
  abstract deleteGroup(id: string): Promise<void>;
  
  abstract saveSettings(settings: Settings): Promise<void>;
  abstract loadSettings(): Promise<Settings | null>;
  abstract clearAll(): Promise<void>;
}