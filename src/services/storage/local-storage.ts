import type { Chat, Settings, ChatGroup, MessageNode, ChatMeta, ChatContent, SidebarItem } from '../../models/types';
import { 
  type ChatMetaDto,
  type ChatGroupDto,
  type HierarchyDto,
  type MigrationChunkDto,
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
  settingsToDomain,
  settingsToDto,
  hierarchyToDomain,
  chatMetaToDto,
  chatContentToDto,
  buildSidebarItemsFromHierarchy,
} from '../../models/mappers';import { IStorageProvider } from './interface';

import { STORAGE_KEY_PREFIX } from '../../models/constants';

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

  async saveHierarchy(hierarchy: HierarchyDto): Promise<void> {
    localStorage.setItem(KEY_HIERARCHY, JSON.stringify(hierarchy));
  }

  // --- Persistence Implementation ---

  async saveChat(chat: Chat, _index: number): Promise<void> {
    // Index is ignored in new hierarchy-first architecture
    await this.saveChatContent(chat.id, chat);
    await this.saveChatMeta(chat);
  }

  async saveChatMeta(meta: ChatMeta): Promise<void> {
    const dto = chatMetaToDto(meta);
    ChatMetaSchemaDto.parse(dto);
    localStorage.setItem(`${KEY_META_PREFIX}${meta.id}`, JSON.stringify(dto));
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
    localStorage.setItem(`${KEY_CONTENT_PREFIX}${id}`, JSON.stringify(dto));
  }

  async loadChat(id: string): Promise<Chat | null> {
    const rawMeta = localStorage.getItem(`${KEY_META_PREFIX}${id}`);
    const rawContent = localStorage.getItem(`${KEY_CONTENT_PREFIX}${id}`);
    if (!rawMeta || !rawContent) return null;

    try {
      const meta = ChatMetaSchemaDto.parse(JSON.parse(rawMeta));
      const content = ChatContentSchemaDto.parse(JSON.parse(rawContent));
      const chat = chatToDomain({ ...meta, ...content });

      // Resolve groupId from hierarchy
      const hierarchy = await this.loadHierarchy();
      if (hierarchy) {
        const group = hierarchy.items.find(i => i.type === 'chat_group' && i.chat_ids.includes(id));
        if (group) chat.groupId = group.id;
      }

      const restoreBlobs = (nodes: MessageNode[]) => {
        for (const node of nodes) {
          if (node.attachments) {
            for (const att of node.attachments) {
              if (att.status === 'memory') {
                const cached = this.blobCache.get(att.id);
                if (cached) (att as unknown as { blob: Blob }).blob = cached;
              }
            }
          }
          if (node.replies?.items) restoreBlobs(node.replies.items);
        }
      };
      restoreBlobs(chat.root.items);

      return chat;
    } catch { return null; }
  }

  async deleteChat(id: string): Promise<void> {
    localStorage.removeItem(`${KEY_META_PREFIX}${id}`);
    localStorage.removeItem(`${KEY_CONTENT_PREFIX}${id}`);
  }

  async saveChatGroup(chatGroup: ChatGroup): Promise<void> {
    const dto = chatGroupToDto(chatGroup);
    ChatGroupSchemaDto.parse(dto);
    localStorage.setItem(`${KEY_GROUP_PREFIX}${chatGroup.id}`, JSON.stringify(dto));
  }

  async loadChatGroup(id: string): Promise<ChatGroup | null> {
    const raw = localStorage.getItem(`${KEY_GROUP_PREFIX}${id}`);
    if (!raw) return null;
    try {
      return chatGroupToDomain(ChatGroupSchemaDto.parse(JSON.parse(raw)));
    } catch { return null; }
  }

  async deleteChatGroup(id: string): Promise<void> {
    localStorage.removeItem(`${KEY_GROUP_PREFIX}${id}`);
  }

  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const [rawHierarchy, rawMetas, rawGroups] = await Promise.all([
      this.loadHierarchy(),
      this.listChatMetasRaw(),
      this.listChatGroupsRaw(),
    ]);

    const hierarchy = hierarchyToDomain(rawHierarchy || { items: [] });
    const chatMetas = rawMetas.map(m => chatToDomain({ ...m, root: { items: [] } }));
    const chatGroups = rawGroups.map(g => chatGroupToDomain(g));

    return buildSidebarItemsFromHierarchy(hierarchy, chatMetas, chatGroups);
  }

  async saveSettings(settings: Settings): Promise<void> {
    const dto = settingsToDto(settings);
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(SettingsSchemaDto.parse(dto)));
  }

  async loadSettings(): Promise<Settings | null> {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (!raw) return null;
    try {
      return settingsToDomain(SettingsSchemaDto.parse(JSON.parse(raw)));
    } catch { return null; }
  }

  // --- File Storage ---
  
  async saveFile(_blob: Blob, _attachmentId: string, _originalName: string): Promise<void> {
    throw new Error('File persistence is not supported in LocalStorage provider.');
  }

  async getFile(_attachmentId: string, _originalName: string): Promise<Blob | null> {
    return null;
  }

  async hasAttachments(): Promise<boolean> {
    return false;
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

  async *dump(): AsyncGenerator<MigrationChunkDto> {
    const settings = await this.loadSettings();
    if (settings) yield { type: 'settings', data: settingsToDto(settings) };

    const hierarchy = await this.loadHierarchy();
    yield { type: 'hierarchy', data: hierarchy || { items: [] } };

    const chatGroups = await this.listChatGroupsRaw();
    for (const g of chatGroups) yield { type: 'chat_group', data: g };

    const metas = await this.listChatMetasRaw();
    for (const m of metas) {
      const chat = await this.loadChat(m.id);
      if (chat) yield { type: 'chat', data: chatToDto(chat) };
    }
  }

  async restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void> {
    await this.clearAll();
    for await (const chunk of stream) {
      const type = chunk.type;
      switch (type) {
      case 'settings':
        await this.saveSettings(settingsToDomain(chunk.data));
        break;
      case 'hierarchy':
        await this.saveHierarchy(chunk.data);
        break;
      case 'chat_group':
        await this.saveChatGroup(chatGroupToDomain(chunk.data));
        break;
      case 'chat': {
        const domainChat = chatToDomain(chunk.data);
        await this.saveChatContent(domainChat.id, domainChat);
        await this.saveChatMeta(domainChat);
        break;
      }
      case 'attachment':
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
