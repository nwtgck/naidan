import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, ChatMeta, ChatContent, StorageSnapshot, BinaryObject, Volume, VolumeType } from '@/01-models/types';
import type { ChatMetaDto, ChatGroupDto, HierarchyDto } from '@/00-storage/00-dto/dto';
import type { BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';

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
    name: string,
    type: VolumeType,
    sourceHandle: FileSystemDirectoryHandle,
  }): Promise<Volume>;

  abstract createVolumeFromFiles({ name, entries, onProgress, signal }: {
    name: string,
    entries: Array<{ file: File, relativePath: string }>,
    onProgress?: ({ processed, total }: { processed: number, total: number }) => void,
    signal?: AbortSignal,
  }): Promise<Volume>;

  abstract getVolumeDirectoryHandle({ volumeId }: {
    volumeId: VolumeId,
  }): Promise<FileSystemDirectoryHandle | null>;

  abstract deleteVolume({ volumeId }: {
    volumeId: VolumeId,
  }): Promise<void>;

  abstract renameVolume({ volumeId, name }: {
    volumeId: VolumeId,
    name: string,
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
  abstract saveChatContent({ id, content }: { id: ChatId, content: ChatContent }): Promise<void>;

  abstract loadChat({ id }: { id: ChatId }): Promise<Chat | null>;
  abstract loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null>;
  abstract loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null>;
  /**
   * Loads chat content without hydrating attachment-backed data.
   * Attachment descriptors may remain on the returned messages.
   */
  abstract loadChatContentWithoutAttachments({ id }: { id: ChatId }): Promise<ChatContent | null>;
  abstract deleteChat({ id }: { id: ChatId }): Promise<void>;

  abstract saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void>;
  abstract loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null>;
  abstract deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void>;

  abstract saveSettings({ settings }: { settings: Settings }): Promise<void>;
  abstract loadSettings(): Promise<Settings | null>;
  abstract clearAll(): Promise<void>;

  // --- File Storage ---
  abstract saveFile({ blob, binaryObjectId, name, mimeType }: {
    blob: Blob,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType?: string,
  }): Promise<void>;
  abstract getFile({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | null>;
  abstract getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null>;
  abstract hasAttachments(): Promise<boolean>;
  abstract listBinaryObjects(): AsyncIterable<BinaryObject>;
  abstract deleteBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void>;
}
