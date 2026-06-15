import type { Chat, Settings, ChatGroup, MessageNode, ChatMeta, ChatContent, SidebarItem, StorageSnapshot, BinaryObject } from '@/models/types';
import type { BinaryObjectId, ChatGroupId, ChatId, VolumeId } from '@/models/ids';
import {
  type ChatMetaDto,
  type ChatGroupDto,
  type HierarchyDto,
  ChatMetaSchemaDto,
  ChatGroupSchemaDto,
  SettingsSchemaDto,
  HierarchySchemaDto,
  ChatContentSchemaDto,
} from '@/models/dto';
import {
  chatToDomain,
  chatToDto,
  chatGroupToDomain,
  chatGroupToDto,
  settingsToDomain,
  settingsToDto,
  hierarchyToDomain,
  hierarchyToDto,
  chatMetaToDto,
  chatMetaToDomain,
  chatContentToDto,
  chatContentToDomain,
  buildSidebarItemsFromHierarchy,
} from '@/models/mappers';
import { IStorageProvider } from './interface';

import { STORAGE_KEY_PREFIX } from '@/models/constants';
import { toChatGroupId, toChatId } from '@/models/ids';

const LSP_STORAGE_PREFIX = `${STORAGE_KEY_PREFIX}lsp:`;
const KEY_HIERARCHY = `${LSP_STORAGE_PREFIX}hierarchy`;
const KEY_SETTINGS = `${LSP_STORAGE_PREFIX}settings`;
const KEY_META_PREFIX = `${LSP_STORAGE_PREFIX}chat_meta:`;
const KEY_GROUP_PREFIX = `${LSP_STORAGE_PREFIX}chat_group:`;
const KEY_CONTENT_PREFIX = `${LSP_STORAGE_PREFIX}chat_content:`;

/**
 * LocalStorage Implementation
 * Optimized by splitting metadata and content into individual keys.
 * Uses a centralized hierarchy record for ordering.
 */
export class LocalStorageProvider extends IStorageProvider {
  readonly canPersistBinary = false;
  private blobCache = new Map<string, Blob>();

  async init(): Promise<void> {
    // No-op for localStorage
  }

  // --- Internal Data Access ---

  protected async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    const metas: ChatMetaDto[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_META_PREFIX)) {
        const raw = localStorage.getItem(key);
        if (raw) metas.push(JSON.parse(raw));
      }
    }
    return metas;
  }

  protected async listChatGroupsRaw(): Promise<ChatGroupDto[]> {
    const groups: ChatGroupDto[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_GROUP_PREFIX)) {
        const raw = localStorage.getItem(key);
        if (raw) groups.push(JSON.parse(raw));
      }
    }
    return groups;
  }

  // --- Hierarchy Management ---

  async loadHierarchy(): Promise<HierarchyDto | null> {
    const raw = localStorage.getItem(KEY_HIERARCHY);
    if (!raw) return { items: [] };
    return HierarchySchemaDto.parse(JSON.parse(raw));
  }

  async saveHierarchy({ hierarchy }: { hierarchy: HierarchyDto }): Promise<void> {
    localStorage.setItem(KEY_HIERARCHY, JSON.stringify(hierarchy));
  }

  // --- Persistence Implementation ---

  async saveChatMeta({ meta }: { meta: ChatMeta }): Promise<void> {
    const dto = chatMetaToDto({ domain: meta });
    ChatMetaSchemaDto.parse(dto);
    localStorage.setItem(`${KEY_META_PREFIX}${meta.id}`, JSON.stringify(dto));
  }

  async saveChatContent({ id, content }: { id: ChatId; content: ChatContent }): Promise<void> {
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
    localStorage.setItem(`${KEY_CONTENT_PREFIX}${id}`, JSON.stringify(dto));
  }

  async loadChat({ id }: { id: ChatId }): Promise<Chat | null> {
    const rawMeta = localStorage.getItem(`${KEY_META_PREFIX}${id}`);
    const rawContent = localStorage.getItem(`${KEY_CONTENT_PREFIX}${id}`);
    if (!rawMeta || !rawContent) return null;

    try {
      const meta = ChatMetaSchemaDto.parse(JSON.parse(rawMeta));
      const content = ChatContentSchemaDto.parse(JSON.parse(rawContent));
      const chat = chatToDomain({ dto: { ...meta, ...content, experimental: meta.experimental, messages: undefined } });

      // Resolve groupId from hierarchy
      const hierarchy = await this.loadHierarchy();
      if (hierarchy) {
        const group = hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
        if (group) chat.groupId = toChatGroupId({ raw: group.id });
      }

      const restoreBlobs = ({ nodes }: { nodes: MessageNode[] }) => {
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
          if (node.replies?.items) restoreBlobs({ nodes: node.replies.items });
        }
      };
      restoreBlobs({ nodes: chat.root.items });

      return chat;
    } catch {
      return null;
    }
  }

  async loadChatMeta({ id }: { id: ChatId }): Promise<ChatMeta | null> {
    const rawMeta = localStorage.getItem(`${KEY_META_PREFIX}${id}`);
    if (!rawMeta) return null;
    try {
      const meta = chatMetaToDomain({ dto: ChatMetaSchemaDto.parse(JSON.parse(rawMeta)) });
      // Resolve groupId from hierarchy
      const hierarchy = await this.loadHierarchy();
      if (hierarchy) {
        const group = hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
        if (group) meta.groupId = toChatGroupId({ raw: group.id });
      }
      return meta;
    } catch {
      return null;
    }
  }

  async loadChatContent({ id }: { id: ChatId }): Promise<ChatContent | null> {
    const rawContent = localStorage.getItem(`${KEY_CONTENT_PREFIX}${id}`);
    if (!rawContent) return null;
    try {
      const dto = ChatContentSchemaDto.parse(JSON.parse(rawContent));
      const content = chatContentToDomain({ dto });

      const restoreBlobs = ({ nodes }: { nodes: MessageNode[] }) => {
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
          if (node.replies?.items) restoreBlobs({ nodes: node.replies.items });
        }
      };
      restoreBlobs({ nodes: content.root.items });

      return content;
    } catch {
      return null;
    }
  }

  async deleteChat({ id }: { id: ChatId }): Promise<void> {
    localStorage.removeItem(`${KEY_META_PREFIX}${id}`);
    localStorage.removeItem(`${KEY_CONTENT_PREFIX}${id}`);
  }

  async saveChatGroup({ chatGroup }: { chatGroup: ChatGroup }): Promise<void> {
    const dto = chatGroupToDto({ domain: chatGroup });
    ChatGroupSchemaDto.parse(dto);
    localStorage.setItem(`${KEY_GROUP_PREFIX}${chatGroup.id}`, JSON.stringify(dto));
  }

  async loadChatGroup({ id }: { id: ChatGroupId }): Promise<ChatGroup | null> {
    const raw = localStorage.getItem(`${KEY_GROUP_PREFIX}${id}`);
    if (!raw) return null;
    try {
      const [hierarchy, allMetas] = await Promise.all([
        this.loadHierarchy(),
        this.listChatMetasRaw()
      ]);
      const chatMetas = allMetas.map(dto => chatMetaToDomain({ dto }));
      const h = hierarchyToDomain({ dto: hierarchy || { items: [] } });
      return chatGroupToDomain({ dto: ChatGroupSchemaDto.parse(JSON.parse(raw)), hierarchy: h, chatMetas });
    } catch {
      return null;
    }
  }

  async deleteChatGroup({ id }: { id: ChatGroupId }): Promise<void> {
    localStorage.removeItem(`${KEY_GROUP_PREFIX}${id}`);
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const [rawHierarchy, rawMetas, rawGroups] = await Promise.all([
      this.loadHierarchy(),
      this.listChatMetasRaw(),
      this.listChatGroupsRaw(),
    ]);

    const hierarchy = hierarchyToDomain({ dto: rawHierarchy || { items: [] } });
    const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));
    const chatGroups = rawGroups.map(dto => chatGroupToDomain({ dto, hierarchy, chatMetas }));

    return buildSidebarItemsFromHierarchy({ hierarchy, chatMetas, chatGroups });
  }

  async saveSettings({ settings }: { settings: Settings }): Promise<void> {
    const dto = settingsToDto({ domain: settings });
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(SettingsSchemaDto.parse(dto)));
  }

  async loadSettings(): Promise<Settings | null> {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (!raw) return null;
    try {
      return settingsToDomain({ dto: SettingsSchemaDto.parse(JSON.parse(raw)) });
    } catch {
      return null;
    }
  }

  // --- Volume Management ---

  async *listVolumes(): AsyncIterable<import('@/models/types').Volume> {
    // LocalStorage doesn't support volumes
  }

  async createVolume({ name: _name, type: _type, sourceHandle: _sourceHandle }: {
    name: string;
    type: import('@/models/types').VolumeType;
    sourceHandle: FileSystemDirectoryHandle;
  }): Promise<import('@/models/types').Volume> {
    throw new Error('Volume management is not supported in LocalStorage provider.');
  }

  async createVolumeFromFiles({ name: _name, entries: _entries, onProgress: _onProgress, signal: _signal }: {
    name: string;
    entries: Array<{ file: File; relativePath: string }>;
    onProgress?: ({ processed, total }: { processed: number; total: number }) => void;
    signal?: AbortSignal;
  }): Promise<import('@/models/types').Volume> {
    throw new Error('Volume management is not supported in LocalStorage provider.');
  }

  async getVolumeDirectoryHandle({ volumeId: _volumeId }: {
    volumeId: VolumeId;
  }): Promise<FileSystemDirectoryHandle | null> {
    return null;
  }

  async deleteVolume({ volumeId: _volumeId }: {
    volumeId: VolumeId;
  }): Promise<void> {
    throw new Error('Volume management is not supported in LocalStorage provider.');
  }

  async renameVolume({ volumeId: _volumeId, name: _name }: {
    volumeId: VolumeId;
    name: string;
  }): Promise<void> {
    throw new Error('Volume management is not supported in LocalStorage provider.');
  }

  // --- File Storage ---

  async saveFile({
    blob: _blob,
    binaryObjectId: _binaryObjectId,
    name: _name,
    mimeType: _mimeType,
  }: {
    blob: Blob;
    binaryObjectId: BinaryObjectId;
    name: string;
    mimeType?: string;
  }): Promise<void> {
    throw new Error('File persistence is not supported in LocalStorage provider.');
  }

  async getFile({ binaryObjectId: _binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<Blob | null> {
    return null;
  }

  async getBinaryObject({ binaryObjectId: _id }: { binaryObjectId: BinaryObjectId }): Promise<BinaryObject | null> {
    return null;
  }

  async hasAttachments(): Promise<boolean> {
    return false;
  }

  async *listBinaryObjects(): AsyncIterable<BinaryObject> {
    // Yields nothing
  }

  async deleteBinaryObject({ binaryObjectId: _binaryObjectId }: { binaryObjectId: BinaryObjectId }): Promise<void> {
    // No-op
  }

  async clearAll(): Promise<void> {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LSP_STORAGE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    this.blobCache.clear();
  }

  // --- Migration Implementation ---

  async dump(): Promise<StorageSnapshot> {
    const [settings, hierarchy, rawMetas, rawGroups] = await Promise.all([
      this.loadSettings(),
      this.loadHierarchy(),
      this.listChatMetasRaw(),
      this.listChatGroupsRaw(),
    ]);

    const chatMetas = rawMetas.map(dto => chatMetaToDomain({ dto }));
    const h = hierarchyToDomain({ dto: hierarchy || { items: [] } });
    const chatGroups = rawGroups.map(dto => chatGroupToDomain({ dto, hierarchy: h, chatMetas }));

    const contentStream = async function* (this: LocalStorageProvider) {
      for (const m of rawMetas) {
        const chat = await this.loadChat({ id: toChatId({ raw: m.id }) });
        if (chat) yield { type: 'chat' as const, data: chatToDto({ domain: chat }) };
      }
    };

    return {
      structure: {
        settings: settings || {
          autoTitleEnabled: true,
          providerProfiles: [],
          mounts: [],
          storageType: 'local',
          endpointType: 'openai',
          endpointUrl: '',
        } as Settings,
        hierarchy: h,
        chatMetas,
        chatGroups,
      },
      contentStream: contentStream.call(this),
    };
  }

  async restore({ snapshot }: { snapshot: StorageSnapshot }): Promise<void> {
    const { structure, contentStream } = snapshot;

    // 1. Restore Structural Metadata (skeleton)
    if (structure.settings) await this.saveSettings({ settings: structure.settings });
    if (structure.hierarchy) await this.saveHierarchy({ hierarchy: hierarchyToDto({ domain: structure.hierarchy }) });
    if (structure.chatMetas) {
      for (const meta of structure.chatMetas) await this.saveChatMeta({ meta });
    }
    if (structure.chatGroups) {
      for (const group of structure.chatGroups) await this.saveChatGroup({ chatGroup: group });
    }

    // 2. Restore Heavy Content (trees)
    for await (const chunk of contentStream) {
      const type = chunk.type;
      switch (type) {
      case 'chat': {
        const domainChat = chatToDomain({ dto: chunk.data });
        await this.saveChatContent({ id: domainChat.id, content: domainChat });
        // Ensure meta is consistent with content
        await this.saveChatMeta({ meta: domainChat });
        break;
      }
      case 'binary_object':
        // LocalStorage does not support binary attachments, skip
        break;
      default: {
        const _ex: never = type;
        throw new Error(`Unknown chunk type: ${_ex}`);
      }
      }
    }
  }
}
