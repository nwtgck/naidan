import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary, ChatMeta, ChatContent, StorageSnapshot, BinaryObject, Volume, VolumeType } from '@/01-models/types';
import type { ChatMetaDto, ChatGroupDto, HierarchyDto } from '@/00-storage/00-dto/dto';
import type {
  StorageBinaryObjectReadHandle,
  StorageBinaryObjectWriteSource,
} from './binary-object-io';
import type { StorageVolumeAccess } from './volume-access';
import {
  materializeStorageBinaryObjectAsBlob,
  runWithStorageBinaryObjectReadHandleClose,
} from './binary-object-io';
import type { BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';

export type { ChatSummary };

/**
 * Base Storage Provider
 * Provides common logic for transforming DTOs to Domain models.
 */
export abstract class IStorageProvider {
  abstract init(): Promise<void>;

  /**
   * Releases provider-lifetime resources after the provider is replaced.
   *
   * The provider must not be used again after this method resolves. Providers
   * without lifetime resources intentionally inherit this no-op implementation.
   */
  async dispose(): Promise<void> {}

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

  abstract openVolume({ volumeId }: {
    volumeId: VolumeId,
  }): Promise<StorageVolumeAccess | null>;


  abstract deleteVolume({ volumeId }: {
    volumeId: VolumeId,
  }): Promise<void>;

  abstract renameVolume({ volumeId, name }: {
    volumeId: VolumeId,
    name: string,
  }): Promise<void>;

  // --- Data Access Methods ---
  abstract listChatMetasRaw(): Promise<ChatMetaDto[]>;
  abstract listChatGroupsRaw(): Promise<ChatGroupDto[]>;

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
  abstract writeBinaryObject({ source, binaryObjectId, name, mimeType, size, createdAt, signal }: {
    source: StorageBinaryObjectWriteSource,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType: string,
    size: number,
    createdAt: number,
    signal: AbortSignal | undefined,
  }): Promise<void>;

  abstract openBinaryObject({ binaryObjectId }: {
    binaryObjectId: BinaryObjectId,
  }): Promise<StorageBinaryObjectReadHandle | null>;

  /**
   * TODO(storage-binary-io): Migrate remaining callers to
   * writeBinaryObject(). This compatibility API must not be used by storage
   * migration, encryption transitions, volumes, or Wesh.
   */
  async saveFile({ blob, binaryObjectId, name, mimeType }: {
    blob: Blob,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType?: string,
  }): Promise<void> {
    const resolvedMimeType = mimeType ?? (blob.type || 'application/octet-stream');
    await this.writeBinaryObject({
      source: { type: 'direct_blob', blob },
      binaryObjectId,
      name,
      mimeType: resolvedMimeType,
      size: blob.size,
      createdAt: Date.now(),
      signal: undefined,
    });
  }

  /**
   * TODO(storage-binary-io): Migrate remaining callers to
   * openBinaryObject(). Reader-only payloads require complete materialization
   * through this compatibility API.
   */
  async getFile({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | null> {
    const handle = await this.openBinaryObject({ binaryObjectId });
    if (handle === null) {
      return null;
    }

    return await runWithStorageBinaryObjectReadHandleClose({
      handle,
      operation: async () => await materializeStorageBinaryObjectAsBlob({ handle }),
    });
  }

  abstract getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null>;
  abstract hasAttachments(): Promise<boolean>;
  abstract listBinaryObjects(): AsyncIterable<BinaryObject>;
  abstract deleteBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void>;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
