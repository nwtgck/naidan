import type { Chat, Settings, ChatGroup, MessageNode, ChatMeta, ChatContent, SidebarItem, StorageSnapshot, BinaryObject } from '@/01-models/types';
import type { AttachmentId, BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';
import {
  type ChatMetaDto,
  type ChatGroupDto,
  type HierarchyDto,
  type ChatContentDto,
  ChatMetaSchemaDto,
  ChatGroupSchemaDto,
  SettingsSchemaDto,
  HierarchySchemaDto,
  ChatContentSchemaDto,
} from '@/00-storage/00-dto/dto';
import {
  chatToDomain,
  chatToDto,
  chatGroupToDomain,
  chatGroupToDto,
  settingsToDto,
  hierarchyToDomain,
  hierarchyToDto,
  chatMetaToDto,
  chatMetaToDomain,
  chatContentToDto,
  chatContentToDomain,
  buildSidebarItemsFromHierarchy,
} from '@/00-storage/mapper/mappers';
import { IStorageProvider } from './interface';
import { idToRaw, toBinaryObjectId, toChatGroupId } from '@/01-models/ids';

/**
 * Memory Storage Implementation
 * Volatile storage that lasts only for the duration of the page session.
 * Useful for ephemeral conversations or testing.
 */
export class MemoryStorageProvider extends IStorageProvider {
  readonly canPersistBinary = true;

  private hierarchy: HierarchyDto = { items: [] };
  private settings: Settings | null = null;
  private chatMetas = new Map<ChatId, ChatMetaDto>();
  private chatGroups = new Map<ChatGroupId, ChatGroupDto>();
  private chatContents = new Map<ChatId, ChatContentDto>();
  private binaryObjects = new Map<BinaryObjectId, { blob: Blob, meta: BinaryObject }>();
  private blobCache = new Map<AttachmentId, Blob>();

  private restoreBlobs({ nodes }: { nodes: MessageNode[] }): void {
    for (const node of nodes) {
      if (node.attachments) {
        for (const att of node.attachments) {
          switch (att.status) {
          case 'memory': {
            const cached = this.blobCache.get(att.id);
            if (cached) (att as unknown as { blob: Blob }).blob = cached;
            break;
          }
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
      this.restoreBlobs({ nodes: node.replies.items });
    }
  }

  private loadUnhydratedChatContent({ id }: { id: ChatId }): ChatContent | null {
    const rawContent = this.chatContents.get(id);
    if (!rawContent) return null;

    try {
      return chatContentToDomain({
        dto: ChatContentSchemaDto.parse(rawContent),
      });
    } catch {
      return null;
    }
  }

  async init(): Promise<void> {
    // No-op for memory storage
  }

  // --- Internal Data Access ---

  protected async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    return Array.from(this.chatMetas.values());
  }

  protected async listChatGroupsRaw(): Promise<ChatGroupDto[]> {
    return Array.from(this.chatGroups.values());
  }

  // --- Hierarchy Management ---

  async loadHierarchy(): Promise<HierarchyDto | null> {
    return { ...this.hierarchy };
  }

  async saveHierarchy({ hierarchy }: { hierarchy: HierarchyDto }): Promise<void> {
    this.hierarchy = HierarchySchemaDto.parse(hierarchy);
  }

  // --- Persistence Implementation ---

  async saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void> {
    const dto = chatMetaToDto({ domain: meta });
    ChatMetaSchemaDto.parse(dto);
    this.chatMetas.set(meta.id, dto);
  }

  async saveChatContent({ id, content }: { id: ChatId, content: ChatContent }): Promise<void> {
    const findAndCacheBlobs = ({ nodes }: { nodes: MessageNode[] }) => {
      for (const node of nodes) {
        if (node.attachments) {
          for (const att of node.attachments) {
            if (att.status === 'memory' && att.blob) {
              this.blobCache.set(att.id, att.blob);
            }
          }
        }
        if (node.replies?.items) {
          findAndCacheBlobs({ nodes: node.replies.items });
        }
      }
    };
    findAndCacheBlobs({ nodes: content.root.items });

    const dto = chatContentToDto({ domain: content });
    ChatContentSchemaDto.parse(dto);
    this.chatContents.set(id, dto);
  }

  async loadChat({ id }: { id: ChatId }): Promise<Chat | null> {
    const rawMeta = this.chatMetas.get(id);
    const rawContent = this.chatContents.get(id);
    if (!rawMeta || !rawContent) return null;

    try {
      const meta = ChatMetaSchemaDto.parse(rawMeta);
      const content = ChatContentSchemaDto.parse(rawContent);
      const chat = chatToDomain({ dto: { ...meta, ...content, experimental: meta.experimental, messages: undefined } });

      // Resolve groupId from hierarchy
      const group = this.hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(idToRaw({ id })));
      if (group) chat.groupId = toChatGroupId({ raw: group.id });

      this.restoreBlobs({ nodes: chat.root.items });

      return chat;
    } catch {
      return null;
    }
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    const rawMeta = this.chatMetas.get(id);
    if (!rawMeta) return null;
    try {
      const meta = chatMetaToDomain({ dto: ChatMetaSchemaDto.parse(rawMeta) });
      // Resolve groupId from hierarchy
      const group = this.hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(idToRaw({ id })));
      if (group) meta.groupId = toChatGroupId({ raw: group.id });
      return meta;
    } catch {
      return null;
    }
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    const content = this.loadUnhydratedChatContent({ id });
    if (content === null) return null;

    this.restoreBlobs({ nodes: content.root.items });
    return content;
  }

  async loadChatContentWithoutAttachments({ id }: { id: ChatId }): Promise<ChatContent | null> {
    return this.loadUnhydratedChatContent({ id });
  }

  async deleteChat({ id }: { id: ChatId }): Promise<void> {
    this.chatMetas.delete(id);
    this.chatContents.delete(id);
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    const dto = chatGroupToDto({ domain: chatGroup });
    ChatGroupSchemaDto.parse(dto);
    this.chatGroups.set(chatGroup.id, dto);
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    const raw = this.chatGroups.get(id);
    if (!raw) return null;
    try {
      const chatMetas = Array.from(this.chatMetas.values()).map(dto => chatMetaToDomain({ dto }));
      return chatGroupToDomain({ dto: ChatGroupSchemaDto.parse(raw), hierarchy: hierarchyToDomain({ dto: this.hierarchy }), chatMetas });
    } catch {
      return null;
    }
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    this.chatGroups.delete(id);
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const hierarchy = hierarchyToDomain({ dto: this.hierarchy });
    const chatMetas = Array.from(this.chatMetas.values()).map(dto => chatMetaToDomain({ dto }));
    const chatGroups = Array.from(this.chatGroups.values()).map(dto => chatGroupToDomain({ dto, hierarchy, chatMetas }));

    return buildSidebarItemsFromHierarchy({ hierarchy, chatMetas, chatGroups });
  }

  async saveSettings({ settings }: { settings: Settings }): Promise<void> {
    const dto = settingsToDto({ domain: settings });
    SettingsSchemaDto.parse(dto);
    this.settings = settings;
  }

  async loadSettings(): Promise<Settings | null> {
    return this.settings;
  }

  // --- Volume Management ---

  async *listVolumes(): AsyncIterable<import('@/01-models/types').Volume> {
    // MemoryStorage doesn't support volumes
  }

  async createVolume({ name: _name, type: _type, sourceHandle: _sourceHandle }: {
    name: string,
    type: import('@/01-models/types').VolumeType,
    sourceHandle: FileSystemDirectoryHandle,
  }): Promise<import('@/01-models/types').Volume> {
    throw new Error('Volume management is not supported in MemoryStorage provider.');
  }

  async createVolumeFromFiles({ name: _name, entries: _entries, onProgress: _onProgress, signal: _signal }: {
    name: string,
    entries: Array<{ file: File, relativePath: string }>,
    onProgress?: ({ processed, total }: { processed: number, total: number }) => void,
    signal?: AbortSignal,
  }): Promise<import('@/01-models/types').Volume> {
    throw new Error('Volume management is not supported in MemoryStorage provider.');
  }

  async getVolumeDirectoryHandle({ volumeId: _volumeId }: {
    volumeId: VolumeId,
  }): Promise<FileSystemDirectoryHandle | null> {
    return null;
  }

  async deleteVolume({ volumeId: _volumeId }: {
    volumeId: VolumeId,
  }): Promise<void> {
    throw new Error('Volume management is not supported in MemoryStorage provider.');
  }

  async renameVolume({ volumeId: _volumeId, name: _name }: {
    volumeId: VolumeId,
    name: string,
  }): Promise<void> {
    throw new Error('Volume management is not supported in MemoryStorage provider.');
  }

  // --- File Storage ---

  async saveFile({ blob, binaryObjectId, name, mimeType }: {
    blob: Blob,
    binaryObjectId: BinaryObjectId,
    name: string,
    mimeType?: string,
  }): Promise<void> {
    const meta: BinaryObject = {
      id: binaryObjectId,
      mimeType: mimeType || blob.type || 'application/octet-stream',
      size: blob.size,
      createdAt: Date.now(),
      name,
    };

    this.binaryObjects.set(binaryObjectId, { blob, meta });
  }

  async getFile({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | null> {
    return this.binaryObjects.get(binaryObjectId)?.blob || null;
  }

  async getBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null> {
    return this.binaryObjects.get(binaryObjectId)?.meta || null;
  }

  async hasAttachments(): Promise<boolean> {
    return this.binaryObjects.size > 0;
  }

  async *listBinaryObjects(): AsyncIterable<BinaryObject> {
    for (const { meta } of this.binaryObjects.values()) {
      yield meta;
    }
  }

  async deleteBinaryObject({ binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
    this.binaryObjects.delete(binaryObjectId);
  }

  async clearAll(): Promise<void> {
    this.hierarchy = { items: [] };
    this.settings = null;
    this.chatMetas.clear();
    this.chatGroups.clear();
    this.chatContents.clear();
    this.binaryObjects.clear();
    this.blobCache.clear();
  }

  // --- Migration Implementation ---

  async dump(): Promise<StorageSnapshot> {
    const settings = await this.loadSettings();
    const chatMetas = Array.from(this.chatMetas.values()).map(dto => chatMetaToDomain({ dto }));
    const hierarchy = hierarchyToDomain({ dto: this.hierarchy });
    const chatGroups = Array.from(this.chatGroups.values()).map(dto => chatGroupToDomain({ dto, hierarchy, chatMetas: [] }));

    const contentStream = async function* (this: MemoryStorageProvider) {
      // 1. Stream all chats
      for (const id of this.chatMetas.keys()) {
        const chat = await this.loadChat({ id });
        if (chat) yield { type: 'chat' as const, data: chatToDto({ domain: chat }) };
      }

      // 2. Stream all binary objects
      for (const [id, { blob, meta }] of this.binaryObjects.entries()) {
        yield {
          type: 'binary_object' as const,
          id: idToRaw({ id }),
          name: meta.name || 'file',
          mimeType: meta.mimeType,
          size: meta.size,
          createdAt: meta.createdAt,
          blob,
        };
      }
    };

    return {
      structure: {
        settings: settings || {
          autoTitleEnabled: true,
          providerProfiles: [],
          mounts: [],
          storageType: 'memory',
          endpoint: { type: 'openai', url: '' },
        } as Settings,
        hierarchy,
        chatMetas,
        chatGroups,
      },
      contentStream: contentStream.call(this),
    };
  }

  async restore({ snapshot }: { snapshot: StorageSnapshot }): Promise<void> {
    const { structure, contentStream } = snapshot;

    if (structure.settings) await this.saveSettings({ settings: structure.settings });
    if (structure.hierarchy) await this.saveHierarchy({ hierarchy: hierarchyToDto({ domain: structure.hierarchy }) });
    if (structure.chatMetas) {
      for (const meta of structure.chatMetas) await this.saveChatMeta({ meta });
    }
    if (structure.chatGroups) {
      for (const group of structure.chatGroups) await this.saveChatGroup({ chatGroup: group });
    }

    for await (const chunk of contentStream) {
      const type = chunk.type;
      switch (type) {
      case 'chat': {
        const domainChat = chatToDomain({ dto: chunk.data });
        await this.saveChatContent({ id: domainChat.id, content: domainChat });
        await this.saveChatMeta({ meta: domainChat });
        break;
      }
      case 'binary_object':
        await this.saveFile({
          blob: chunk.blob,
          binaryObjectId: toBinaryObjectId({ raw: chunk.id }),
          name: chunk.name,
          mimeType: chunk.mimeType,
        });
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unknown chunk type: ${_ex}`);
      }
      }
    }
  }
}
