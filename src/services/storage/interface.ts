import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, ChatMeta, ChatContent, StorageSnapshot, BinaryObject, Volume, VolumeType } from '@/models/types';
import type { ChatMetaDto, ChatGroupDto, HierarchyDto } from '@/models/dto';

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

  // --- Volume Management ---

  abstract listVolumes(): AsyncIterable<Volume>;

  abstract createVolume({ name, type, sourceHandle }: {
    name: string;
    type: VolumeType;
    sourceHandle: FileSystemDirectoryHandle;
  }): Promise<Volume>;

  abstract createVolumeFromFiles({ name, entries, onProgress, signal }: {
    name: string;
    entries: Array<{ file: File; relativePath: string }>;
    onProgress?: ({ processed, total }: { processed: number; total: number }) => void;
    signal?: AbortSignal;
  }): Promise<Volume>;

  abstract getVolumeDirectoryHandle({ volumeId }: {
    volumeId: string;
  }): Promise<FileSystemDirectoryHandle | null>;

  abstract deleteVolume({ volumeId }: {
    volumeId: string;
  }): Promise<void>;

  abstract renameVolume({ volumeId, name }: {
    volumeId: string;
    name: string;
  }): Promise<void>;

  // --- Data Access Methods ---
  protected abstract listChatMetasRaw(): Promise<ChatMetaDto[]>;
  protected abstract listChatGroupsRaw(): Promise<ChatGroupDto[]>;

  // --- Hierarchy Management ---
  abstract loadHierarchy(): Promise<HierarchyDto | null>;
  abstract saveHierarchy({ hierarchy }: { hierarchy: HierarchyDto }): Promise<void>;

  // --- Bulk Operations (Migration) ---
  abstract dump(): Promise<StorageSnapshot>;
  abstract restore({ snapshot }: { snapshot: StorageSnapshot }): Promise<void>;

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
          allSummaries.push(nested.chat);
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
  abstract saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void>;

  /**
   * Saves only the chat content (message tree) to a dedicated file.
   */
  abstract saveChatContent({ id, content }: { id: string; content: ChatContent }): Promise<void>;

  abstract loadChat({ id }: { id: string }): Promise<Chat | null>;
  abstract loadChatMeta({ id }: { id: string }): Promise<ChatMeta | null>;
  abstract loadChatContent({ id }: { id: string }): Promise<ChatContent | null>;
  abstract deleteChat({ id }: { id: string }): Promise<void>;

  abstract saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void>;
  abstract loadChatGroup({ id }: { id: string }): Promise<ChatGroup | null>;
  abstract deleteChatGroup({ id }: { id: string }): Promise<void>;

  abstract saveSettings({ settings }: { settings: Settings }): Promise<void>;
  abstract loadSettings(): Promise<Settings | null>;
  abstract clearAll(): Promise<void>;

  // --- File Storage ---
  abstract saveFile({ blob, binaryObjectId, name, mimeType }: {
    blob: Blob;
    binaryObjectId: string;
    name: string;
    mimeType?: string;
  }): Promise<void>;
  abstract getFile({ binaryObjectId }: { binaryObjectId: string }): Promise<Blob | null>;
  abstract getBinaryObject({ binaryObjectId }: { binaryObjectId: string }): Promise<BinaryObject | null>;
  abstract hasAttachments(): Promise<boolean>;
  abstract listBinaryObjects(): AsyncIterable<BinaryObject>;
  abstract deleteBinaryObject({ binaryObjectId }: { binaryObjectId: string }): Promise<void>;
}
