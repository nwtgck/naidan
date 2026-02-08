import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, ChatMeta, ChatContent, StorageSnapshot, BinaryObject } from '../../models/types';
import type { ChatMetaDto, ChatGroupDto, HierarchyDto } from '../../models/dto';

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
  protected abstract listChatMetasRaw(): Promise<ChatMetaDto[]>;
  protected abstract listChatGroupsRaw(): Promise<ChatGroupDto[]>;

  // --- Hierarchy Management ---
  abstract loadHierarchy(): Promise<HierarchyDto | null>;
  abstract saveHierarchy(hierarchy: HierarchyDto): Promise<void>;

  // --- Bulk Operations (Migration) ---
  abstract dump(): Promise<StorageSnapshot>;
  abstract restore(snapshot: StorageSnapshot): Promise<void>;

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
      switch (item.type) {
      case 'chat_group':
        item.chatGroup.items.forEach(nested => {
          switch (nested.type) {
          case 'chat':
            allSummaries.push(nested.chat);
            break;
          case 'chat_group':
            // Nested groups not supported but handled for exhaustiveness
            break;
          default: {
            const _ex: never = nested;
            throw new Error(`Unhandled sidebar item type: ${_ex}`);
          }
          }
        });
        break;
      case 'chat':
        allSummaries.push(item.chat);
        break;
      default: {
        const _ex: never = item;
        throw new Error(`Unhandled sidebar item type: ${_ex}`);
      }
      }
    });
    return allSummaries;
  }

  /**
   * Centralized method to get the full sorted hierarchy using mappers.
   */
  public abstract getSidebarStructure(): Promise<SidebarItem[]>;

  // --- Persistence Methods ---
  
  /**
   * Persists chat metadata (title, updated date, etc).
   */
  abstract saveChatMeta(meta: ChatMeta): Promise<void>;

  /**
   * Saves only the chat content (message tree) to a dedicated file.
   */
  abstract saveChatContent(id: string, content: ChatContent): Promise<void>;

  abstract loadChat(id: string): Promise<Chat | null>;
  abstract loadChatMeta(id: string): Promise<ChatMeta | null>;
  abstract loadChatContent(id: string): Promise<ChatContent | null>;
  abstract deleteChat(id: string): Promise<void>;
  
  abstract saveChatGroup(chatGroup: ChatGroup): Promise<void>;
  abstract loadChatGroup(id: string): Promise<ChatGroup | null>;
  abstract deleteChatGroup(id: string): Promise<void>;
  
  abstract saveSettings(settings: Settings): Promise<void>;
  abstract loadSettings(): Promise<Settings | null>;
  abstract clearAll(): Promise<void>;

  // --- File Storage ---
  /**
   * @deprecated Use the named arguments version instead.
   */
  abstract saveFile(blob: Blob, binaryObjectId: string, name: string, mimeType?: string, size?: number): Promise<void>;
  abstract saveFile(params: {
    blob: Blob;
    binaryObjectId: string;
    name: string;
    mimeType: string | undefined;
  }): Promise<void>;
  abstract getFile(binaryObjectId: string): Promise<Blob | null>;
  abstract hasAttachments(): Promise<boolean>;
  abstract listBinaryObjects(): AsyncIterable<BinaryObject>;
  abstract deleteBinaryObject(binaryObjectId: string): Promise<void>;
}