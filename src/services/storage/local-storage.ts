import type { Chat, Settings, ChatGroup } from '../../models/types';
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
const KEY_GROUPS = `${LSP_STORAGE_PREFIX}groups`;
const KEY_SETTINGS = `${LSP_STORAGE_PREFIX}settings`;
const KEY_CHAT_PREFIX = `${LSP_STORAGE_PREFIX}chat:`;

/**
 * LocalStorage Implementation
 * Optimized by splitting metadata and content.
 */
export class LocalStorageProvider extends IStorageProvider {
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

  protected async listGroupsRaw(): Promise<ChatGroupDto[]> {
    const raw = localStorage.getItem(KEY_GROUPS);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch { return []; }
  }

  // --- Persistence Implementation ---

  async saveChat(chat: Chat, index: number): Promise<void> {
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
      return chatToDomain({ ...meta, ...content });
    } catch { return null; }
  }

  async deleteChat(id: string): Promise<void> {
    localStorage.removeItem(`${KEY_CHAT_PREFIX}${id}`);
    const entries = (await this.listChatMetasRaw()).filter(m => m.id !== id);
    localStorage.setItem(KEY_INDEX, JSON.stringify({ entries }));
  }

  async saveGroup(group: ChatGroup, index: number): Promise<void> {
    const dto = chatGroupToDto(group, index);
    const all = await this.listGroupsRaw();
    const existingIndex = all.findIndex(g => g.id === group.id);
    if (existingIndex >= 0) all[existingIndex] = dto;
    else all.push(dto);
    localStorage.setItem(KEY_GROUPS, JSON.stringify(all));
  }

  async loadGroup(_id: string): Promise<ChatGroup | null> {
    return null;
  }

  async deleteGroup(id: string): Promise<void> {
    const groups = (await this.listGroupsRaw()).filter(g => g.id !== id);
    localStorage.setItem(KEY_GROUPS, JSON.stringify(groups));
    
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
  }

  // --- Migration Implementation ---

  async *dump(): AsyncGenerator<MigrationChunkDto> {
    const settings = await this.loadSettings();
    if (settings) yield { type: 'settings', data: settingsToDto(settings) };

    const groups = await this.listGroupsRaw();
    for (const g of groups) yield { type: 'group', data: g };

    const metas = await this.listChatMetasRaw();
    for (const m of metas) {
      const chat = await this.loadChat(m.id);
      if (chat) yield { type: 'chat', data: chatToDto(chat, m.order ?? 0) };
    }
  }

  async restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void> {
    await this.clearAll();
    const groups: ChatGroupDto[] = [];
    const metas: ChatMetaDto[] = [];

    for await (const chunk of stream) {
      if (chunk.type === 'settings') {
        await this.saveSettings(settingsToDomain(chunk.data));
      } else if (chunk.type === 'group') {
        groups.push(chunk.data);
      } else if (chunk.type === 'chat') {
        const fullDto = chunk.data;
        // Save content
        const { root, currentLeafId, ...meta } = fullDto;
        localStorage.setItem(`${KEY_CHAT_PREFIX}${fullDto.id}`, JSON.stringify({ root, currentLeafId }));
        metas.push(meta as ChatMetaDto);
      }
    }

    localStorage.setItem(KEY_GROUPS, JSON.stringify(groups));
    localStorage.setItem(KEY_INDEX, JSON.stringify({ entries: metas }));
  }
}