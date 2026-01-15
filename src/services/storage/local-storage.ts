import type { Chat, Settings, ChatGroup, MessageNode } from '../../models/types';
import { 
  SettingsSchemaDto, 
  ChatMetaIndexSchemaDto,
  ChatMetaSchemaDto,
  ChatContentSchemaDto,
  type ChatGroupDto, 
  type ChatMetaDto,
  type ChatContentDto,
  type MigrationChunkDto,
} from '../../models/dto';
import { 
  chatToDomain,
  chatToDto,
  settingsToDomain,
  settingsToDto,
  chatGroupToDto,
} from '../../models/mappers';
import { IStorageProvider } from './interface';

import { STORAGE_KEY_PREFIX } from '../../models/constants';

const LSP_STORAGE_PREFIX = `${STORAGE_KEY_PREFIX}lsp:`;
const KEY_INDEX = `${LSP_STORAGE_PREFIX}index`;
const KEY_CHAT_GROUPS = `${LSP_STORAGE_PREFIX}chat_groups`;
const KEY_SETTINGS = `${LSP_STORAGE_PREFIX}settings`;
const KEY_CHAT_PREFIX = `${LSP_STORAGE_PREFIX}chat:`;

/**
 * LocalStorage Implementation
 * Optimized by splitting metadata and content.
 * Includes a session-level memory cache for Blobs to support "rescuing" them
 * during migration or provider switching.
 */
export class LocalStorageProvider extends IStorageProvider {
  readonly canPersistBinary = false;
  private blobCache = new Map<string, Blob>();

  async init(): Promise<void> {
    // No-op for localStorage
  }

  // --- Internal Data Access ---

  protected async listChatMetasRaw(): Promise<ChatMetaDto[]> {
    const raw = localStorage.getItem(KEY_INDEX);
    if (!raw) return [];
    try {
      const json = JSON.parse(raw);
      const validated = ChatMetaIndexSchemaDto.parse(json);
      return validated.entries;
    } catch { return []; }
  }

  protected async listChatGroupsRaw(): Promise<ChatGroupDto[]> {
    const raw = localStorage.getItem(KEY_CHAT_GROUPS);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch { return []; }
  }

  // --- Persistence Implementation ---

  async saveChat(chat: Chat, index: number): Promise<void> {
    // Collect memory blobs before stringifying
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
    findAndCacheBlobs(chat.root.items);

    const fullDto = chatToDto(chat, index);
    
    // 1. Save Content (Large)
    const contentDto: ChatContentDto = {
      root: fullDto.root || { items: [] },
      currentLeafId: fullDto.currentLeafId,
    };
    ChatContentSchemaDto.parse(contentDto);
    localStorage.setItem(`${KEY_CHAT_PREFIX}${chat.id}`, JSON.stringify(contentDto));

    // 2. Update Meta Index (Small)
    const { root: _r, currentLeafId: _c, ...metaDto } = fullDto;
    ChatMetaSchemaDto.parse(metaDto);
    
    const entries = await this.listChatMetasRaw();
    const existingIndex = entries.findIndex(m => m.id === chat.id);
    if (existingIndex >= 0) entries[existingIndex] = metaDto as ChatMetaDto;
    else entries.push(metaDto as ChatMetaDto);
    
    localStorage.setItem(KEY_INDEX, JSON.stringify({ entries }));
  }

  async loadChat(id: string): Promise<Chat | null> {
    const metas = await this.listChatMetasRaw();
    const meta = metas.find(m => m.id === id);
    if (!meta) return null;

    const rawContent = localStorage.getItem(`${KEY_CHAT_PREFIX}${id}`);
    if (!rawContent) return null;

    try {
      const content = ChatContentSchemaDto.parse(JSON.parse(rawContent));
      const chat = chatToDomain({ ...meta, ...content });

      // Restore blobs from cache if available
      const restoreBlobs = (nodes: MessageNode[]) => {
        for (const node of nodes) {
          if (node.attachments) {
            for (const att of node.attachments) {
              if (att.status === 'memory') {
                const cached = this.blobCache.get(att.id);
                if (cached) {
                  // Re-assigning to avoid TS error on readonly/union types if necessary
                  // but status is already checked, so blob should be available if we cast
                  (att as unknown as { blob: Blob }).blob = cached;
                }
              }
            }
          }
          if (node.replies?.items) {
            restoreBlobs(node.replies.items);
          }
        }
      };
      restoreBlobs(chat.root.items);

      return chat;
    } catch { return null; }
  }

  async deleteChat(id: string): Promise<void> {
    localStorage.removeItem(`${KEY_CHAT_PREFIX}${id}`);
    const entries = (await this.listChatMetasRaw()).filter(m => m.id !== id);
    localStorage.setItem(KEY_INDEX, JSON.stringify({ entries }));
    // Note: We don't easily know which blobs belong to this chat here without loading it,
    // but session-level cache is small enough that we can just let it be.
  }

  async saveChatGroup(chatGroup: ChatGroup, index: number): Promise<void> {
    const dto = chatGroupToDto(chatGroup, index);
    const all = await this.listChatGroupsRaw();
    const existingIndex = all.findIndex(g => g.id === chatGroup.id);
    if (existingIndex >= 0) all[existingIndex] = dto;
    else all.push(dto);
    localStorage.setItem(KEY_CHAT_GROUPS, JSON.stringify(all));
  }

  async loadChatGroup(_id: string): Promise<ChatGroup | null> {
    return null;
  }

  async deleteChatGroup(id: string): Promise<void> {
    const chatGroups = (await this.listChatGroupsRaw()).filter(g => g.id !== id);
    localStorage.setItem(KEY_CHAT_GROUPS, JSON.stringify(chatGroups));
    
    // Detach chats
    const entries = await this.listChatMetasRaw();
    let changed = false;
    entries.forEach(m => {
      if (m.groupId === id) {
        m.groupId = null;
        changed = true;
      }
    });
    if (changed) {
      localStorage.setItem(KEY_INDEX, JSON.stringify({ entries }));
    }
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
    // LocalStorage does not support heavy file persistence.
    // The StorageService should delegate to OPFS or handle this restriction.
    throw new Error('File persistence is not supported in LocalStorage provider.');
  }

  async getFile(_attachmentId: string, _originalName: string): Promise<Blob | null> {
    return null;
  }

  async hasAttachments(): Promise<boolean> {
    return false;
  }

  async clearAll(): Promise<void> {
    // Prefix based cleanup to ensure everything under our namespace is gone
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LSP_STORAGE_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
    this.blobCache.clear();
  }

  // --- Migration Implementation ---

  async *dump(): AsyncGenerator<MigrationChunkDto> {
    const settings = await this.loadSettings();
    if (settings) yield { type: 'settings', data: settingsToDto(settings) };

    const chatGroups = await this.listChatGroupsRaw();
    for (const g of chatGroups) yield { type: 'chat_group', data: g };

    const metas = await this.listChatMetasRaw();
    for (const m of metas) {
      const chat = await this.loadChat(m.id);
      if (chat) {
        yield { type: 'chat', data: chatToDto(chat, m.order ?? 0) };
      }
    }
  }

  async restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void> {
    await this.clearAll();
    const chatGroups: ChatGroupDto[] = [];
    const metas: ChatMetaDto[] = [];

    for await (const chunk of stream) {
      if (chunk.type === 'settings') {
        await this.saveSettings(settingsToDomain(chunk.data));
      } else if (chunk.type === 'chat_group') {
        chatGroups.push(chunk.data);
      }
      else if (chunk.type === 'chat') {
        const fullDto = chunk.data;
        // Save content
        const { root, currentLeafId, ...meta } = fullDto;
        localStorage.setItem(`${KEY_CHAT_PREFIX}${fullDto.id}`, JSON.stringify({ root, currentLeafId }));
        metas.push(meta as ChatMetaDto);
      } else if (chunk.type === 'attachment') {
        // LocalStorage does not support binary files.
        // We could theoretically store as base64 but we decided to keep it clean.
      }
    }

    localStorage.setItem(KEY_CHAT_GROUPS, JSON.stringify(chatGroups));
    localStorage.setItem(KEY_INDEX, JSON.stringify({ entries: metas }));
  }
}