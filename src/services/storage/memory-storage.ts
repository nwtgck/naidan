import type { Chat, Settings, ChatGroup, MessageNode, ChatMeta, ChatContent, SidebarItem, StorageSnapshot, BinaryObject } from '../../models/types';
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
} from '../../models/dto';
import {
  chatToDomain,
  chatToDto,
  chatGroupToDomain,
  chatGroupToDto,
  settingsToDto,
  hierarchyToDomain,
  chatMetaToDto,
  chatMetaToDomain,
  chatContentToDto,
  chatContentToDomain,
  buildSidebarItemsFromHierarchy,
  binaryObjectToDomain,
} from '../../models/mappers';
import { IStorageProvider } from './interface';

/**
 * Memory Storage Implementation
 * Volatile storage that lasts only for the duration of the page session.
 * Useful for ephemeral conversations or testing.
 */
export class MemoryStorageProvider extends IStorageProvider {
  readonly canPersistBinary = true;

  private hierarchy: HierarchyDto = { items: [] };
  private settings: Settings | null = null;
  private chatMetas = new Map<string, ChatMetaDto>();
  private chatGroups = new Map<string, ChatGroupDto>();
  private chatContents = new Map<string, ChatContentDto>();
  private binaryObjects = new Map<string, { blob: Blob; meta: BinaryObject }>();
  private blobCache = new Map<string, Blob>();

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

  async saveHierarchy(hierarchy: HierarchyDto): Promise<void> {
    this.hierarchy = HierarchySchemaDto.parse(hierarchy);
  }

  // --- Persistence Implementation ---

  async saveChatMeta(meta: ChatMeta): Promise<void> {
    const dto = chatMetaToDto(meta);
    ChatMetaSchemaDto.parse(dto);
    this.chatMetas.set(meta.id, dto);
  }

  async saveChatContent(id: string, content: ChatContent): Promise<void> {
    const findAndCacheBlobs = (nodes: MessageNode[]) => {
      for (const node of nodes) {
        if (node.attachments) {
          for (const att of node.attachments) {
            if (att.status === 'memory' && att.blob) {
              this.blobCache.set(att.id, att.blob);
            }
          }
        }
        if (node.replies?.items) {
          findAndCacheBlobs(node.replies.items);
        }
      }
    };
    findAndCacheBlobs(content.root.items);

    const dto = chatContentToDto(content);
    ChatContentSchemaDto.parse(dto);
    this.chatContents.set(id, dto);
  }

  async loadChat(id: string): Promise<Chat | null> {
    const rawMeta = this.chatMetas.get(id);
    const rawContent = this.chatContents.get(id);
    if (!rawMeta || !rawContent) return null;

    try {
      const meta = ChatMetaSchemaDto.parse(rawMeta);
      const content = ChatContentSchemaDto.parse(rawContent);
      const chat = chatToDomain({ ...meta, ...content });

      // Resolve groupId from hierarchy
      const group = this.hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
      if (group) chat.groupId = group.id;

      const restoreBlobs = (nodes: MessageNode[]) => {
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
          if (node.replies?.items) restoreBlobs(node.replies.items);
        }
      };
      restoreBlobs(chat.root.items);

      return chat;
    } catch {
      return null;
    }
  }

  async loadChatMeta(id: string): Promise<ChatMeta | null> {
    const rawMeta = this.chatMetas.get(id);
    if (!rawMeta) return null;
    try {
      const meta = chatMetaToDomain(ChatMetaSchemaDto.parse(rawMeta));
      // Resolve groupId from hierarchy
      const group = this.hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
      if (group) meta.groupId = group.id;
      return meta;
    } catch {
      return null;
    }
  }

  async loadChatContent(id: string): Promise<ChatContent | null> {
    const rawContent = this.chatContents.get(id);
    if (!rawContent) return null;
    try {
      const dto = ChatContentSchemaDto.parse(rawContent);
      const content = chatContentToDomain(dto);

      const restoreBlobs = (nodes: MessageNode[]) => {
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
          if (node.replies?.items) restoreBlobs(node.replies.items);
        }
      };
      restoreBlobs(content.root.items);

      return content;
    } catch {
      return null;
    }
  }

  async deleteChat(id: string): Promise<void> {
    this.chatMetas.delete(id);
    this.chatContents.delete(id);
  }

  async saveChatGroup(chatGroup: ChatGroup): Promise<void> {
    const dto = chatGroupToDto(chatGroup);
    ChatGroupSchemaDto.parse(dto);
    this.chatGroups.set(chatGroup.id, dto);
  }

  async loadChatGroup(id: string): Promise<ChatGroup | null> {
    const raw = this.chatGroups.get(id);
    if (!raw) return null;
    try {
      const chatMetas = Array.from(this.chatMetas.values()).map(chatMetaToDomain);
      return chatGroupToDomain(ChatGroupSchemaDto.parse(raw), this.hierarchy, chatMetas);
    } catch {
      return null;
    }
  }

  async deleteChatGroup(id: string): Promise<void> {
    this.chatGroups.delete(id);
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const hierarchy = hierarchyToDomain(this.hierarchy);
    const chatMetas = Array.from(this.chatMetas.values()).map(chatMetaToDomain);
    const chatGroups = Array.from(this.chatGroups.values()).map(g => chatGroupToDomain(g, hierarchy, chatMetas));

    return buildSidebarItemsFromHierarchy(hierarchy, chatMetas, chatGroups);
  }

  async saveSettings(settings: Settings): Promise<void> {
    const dto = settingsToDto(settings);
    SettingsSchemaDto.parse(dto);
    this.settings = settings;
  }

  async loadSettings(): Promise<Settings | null> {
    return this.settings;
  }

  // --- File Storage ---

  async saveFile(blobOrParams: Blob | { blob: Blob; binaryObjectId: string; name: string; mimeType: string | undefined }, binaryObjectId?: string, name?: string, mimeType?: string): Promise<void> {
    let blob: Blob;
    let bId: string;
    let fileName: string;
    let mType: string | undefined;

    if (blobOrParams instanceof Blob) {
      blob = blobOrParams;
      bId = binaryObjectId!;
      fileName = name!;
      mType = mimeType;
    } else {
      blob = blobOrParams.blob;
      bId = blobOrParams.binaryObjectId;
      fileName = blobOrParams.name;
      mType = blobOrParams.mimeType;
    }

    const meta: BinaryObject = {
      id: bId,
      mimeType: mType || blob.type || 'application/octet-stream',
      size: blob.size,
      createdAt: Date.now(),
      name: fileName,
    };

    this.binaryObjects.set(bId, { blob, meta });
  }

  async getFile(binaryObjectId: string): Promise<Blob | null> {
    return this.binaryObjects.get(binaryObjectId)?.blob || null;
  }

  async getBinaryObject({ binaryObjectId }: { binaryObjectId: string }): Promise<BinaryObject | null> {
    return this.binaryObjects.get(binaryObjectId)?.meta || null;
  }

  async hasAttachments(): Promise<boolean> {
    return this.binaryObjects.size > 0;
  }

  async *listBinaryObjects(): AsyncIterable<BinaryObject> {
    for (const { meta } of this.binaryObjects.values()) {
      yield binaryObjectToDomain(meta);
    }
  }

  async deleteBinaryObject(binaryObjectId: string): Promise<void> {
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
    const chatMetas = Array.from(this.chatMetas.values()).map(chatMetaToDomain);
    const chatGroups = Array.from(this.chatGroups.values()).map(g => chatGroupToDomain(g, this.hierarchy, []));

    const contentStream = async function* (this: MemoryStorageProvider) {
      // 1. Stream all chats
      for (const id of this.chatMetas.keys()) {
        const chat = await this.loadChat(id);
        if (chat) yield { type: 'chat' as const, data: chatToDto(chat) };
      }

      // 2. Stream all binary objects
      for (const [id, { blob, meta }] of this.binaryObjects.entries()) {
        yield {
          type: 'binary_object' as const,
          id,
          name: meta.name || 'file',
          mimeType: meta.mimeType,
          size: meta.size,
          createdAt: meta.createdAt,
          blob
        };
      }
    };

    return {
      structure: {
        settings: settings || {
          autoTitleEnabled: true,
          providerProfiles: [],
          storageType: 'memory',
          endpointType: 'openai',
          endpointUrl: '',
        } as Settings,
        hierarchy: this.hierarchy,
        chatMetas,
        chatGroups,
      },
      contentStream: contentStream.call(this),
    };
  }

  async restore(snapshot: StorageSnapshot): Promise<void> {
    const { structure, contentStream } = snapshot;

    if (structure.settings) await this.saveSettings(structure.settings);
    if (structure.hierarchy) await this.saveHierarchy(structure.hierarchy);
    if (structure.chatMetas) {
      for (const meta of structure.chatMetas) await this.saveChatMeta(meta);
    }
    if (structure.chatGroups) {
      for (const group of structure.chatGroups) await this.saveChatGroup(group);
    }

    for await (const chunk of contentStream) {
      const type = chunk.type;
      switch (type) {
      case 'chat': {
        const domainChat = chatToDomain(chunk.data);
        await this.saveChatContent(domainChat.id, domainChat);
        await this.saveChatMeta(domainChat);
        break;
      }
      case 'binary_object':
        await this.saveFile({
          blob: chunk.blob,
          binaryObjectId: chunk.id,
          name: chunk.name,
          mimeType: chunk.mimeType
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
