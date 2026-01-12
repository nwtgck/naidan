import type { 
  Chat, 
  Settings, 
  ChatGroup,
  SidebarItem,
} from '../../models/types';
import { 
  ChatSchemaDto as DtoChatSchema, 
  SettingsSchemaDto as DtoSettingsSchema,
  ChatGroupSchemaDto as DtoChatGroupSchema,
  type ChatGroupDto,
  type ChatDto,
  type MigrationChunkDto,
} from '../../models/dto';
import { 
  chatToDomain as mapChatToDomain,
  chatToDto as mapChatToDto,
  settingsToDomain as mapSettingsToDomain,
  settingsToDto as mapSettingsToDto,
  chatGroupToDto as mapGroupToDto,
  buildSidebarItemsFromDtos,
} from '../../models/mappers';
import { IStorageProvider } from './interface';
import { STORAGE_KEY_PREFIX as KEY_PREFIX } from '../../models/constants';

const KEY_INDEX = `${KEY_PREFIX}index`;
const KEY_GROUPS = `${KEY_PREFIX}groups`;
const KEY_SETTINGS = `${KEY_PREFIX}settings`;

export class LocalStorageProvider extends IStorageProvider {
  async init(): Promise<void> {}

  // --- Internal Data Access (Implementing abstract protected methods) ---

  protected async listChatsRaw(): Promise<ChatDto[]> {
    const raw = localStorage.getItem(KEY_INDEX);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as ChatDto[];
    } catch { return []; }
  }

  protected async listGroupsRaw(): Promise<ChatGroupDto[]> {
    const rawGroups = localStorage.getItem(KEY_GROUPS);
    if (!rawGroups) return [];
    try {
      return JSON.parse(rawGroups) as ChatGroupDto[];
    } catch { return []; }
  }

  // --- Persistence Implementation ---

  async saveChat(chat: Chat, index: number): Promise<void> {
    const dto = mapChatToDto(chat, index);
    const validated = DtoChatSchema.parse(dto);
    localStorage.setItem(`${KEY_PREFIX}chat:${chat.id}`, JSON.stringify(validated));
    
    const indexList = await this.listChatsRaw();
    const existingIdx = indexList.findIndex(c => c.id === chat.id);
    if (existingIdx >= 0) indexList[existingIdx] = validated;
    else indexList.push(validated);
    
    localStorage.setItem(KEY_INDEX, JSON.stringify(indexList));
  }

  async loadChat(id: string): Promise<Chat | null> {
    const raw = localStorage.getItem(`${KEY_PREFIX}chat:${id}`);
    if (!raw) return null;
    try {
      const dto = DtoChatSchema.parse(JSON.parse(raw));
      return mapChatToDomain(dto);
    } catch { return null; }
  }

  async deleteChat(id: string): Promise<void> {
    localStorage.removeItem(`${KEY_PREFIX}chat:${id}`);
    const indexList = (await this.listChatsRaw()).filter(c => c.id !== id);
    localStorage.setItem(KEY_INDEX, JSON.stringify(indexList));
  }

  async saveGroup(group: ChatGroup, index: number): Promise<void> {
    const groups = await this.listGroupsRaw();
    const idx = groups.findIndex(g => g.id === group.id);
    
    const dto = mapGroupToDto(group, index);
    DtoChatGroupSchema.parse(dto);

    if (idx >= 0) groups[idx] = dto;
    else groups.push(dto);
    
    localStorage.setItem(KEY_GROUPS, JSON.stringify(groups));
  }

  async loadGroup(_id: string): Promise<ChatGroup | null> {
    // Note: Use public listGroups() from base class if full structure is needed.
    return null;
  }

  async deleteGroup(id: string): Promise<void> {
    const groups = (await this.listGroupsRaw()).filter(g => g.id !== id);
    localStorage.setItem(KEY_GROUPS, JSON.stringify(groups));
    
    const chats = await this.listChatsRaw();
    for (const c of chats) {
      if (c.groupId === id) {
        const fullChat = await this.loadChat(c.id);
        if (fullChat) {
          fullChat.groupId = null;
          // When removing group, keep original relative order if possible
          await this.saveChat(fullChat, c.order ?? 0);
        }
      }
    }
  }

  /**
   * Overriding getSidebarStructure to ensure we use the DTO mapper.
   */
  public override async getSidebarStructure(): Promise<SidebarItem[]> {
    const [chats, groups] = await Promise.all([
      this.listChatsRaw(),
      this.listGroupsRaw(),
    ]);
    return buildSidebarItemsFromDtos(groups, chats);
  }

  async saveSettings(settings: Settings): Promise<void> {
    const dto = mapSettingsToDto(settings);
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(DtoSettingsSchema.parse(dto)));
  }

  async loadSettings(): Promise<Settings | null> {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (!raw) return null;
    try {
      const dto = DtoSettingsSchema.parse(JSON.parse(raw));
      return mapSettingsToDomain(dto);
    } catch { return null; }
  }

  async clearAll(): Promise<void> {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  }

  // --- Migration Implementation ---

  async *dump(): AsyncGenerator<MigrationChunkDto> {
    // 1. Settings
    const settings = await this.loadSettings();
    if (settings) {
      // Note: We need to convert domain Settings back to DTO for migration
      // Ideally loadSettings should return DTO or we have a raw accessor.
      // For now, re-serialize via mapping to ensure Schema validity.
      const dto = mapSettingsToDto(settings);
      yield { type: 'settings', data: dto };
    }

    // 2. Groups
    const groups = await this.listGroupsRaw();
    for (const group of groups) {
      yield { type: 'group', data: group };
    }

    // 3. Chats
    const chats = await this.listChatsRaw();
    for (const chat of chats) {
      yield { type: 'chat', data: chat };
    }
  }

  async restore(stream: AsyncGenerator<MigrationChunkDto>): Promise<void> {
    await this.clearAll();

    for await (const chunk of stream) {
      switch (chunk.type) {
      case 'settings': {
        const domain = mapSettingsToDomain(chunk.data);
        await this.saveSettings(domain);
        break;
      }
      case 'group': {
        // We can't easily map back from DTO to Domain without 'index' context in some mappers.
        // However, saveGroup expects Domain object.
        // Let's rely on the raw DTO saving mechanism or enhance saveGroup?
        // LocalStorage saveGroup uses mapGroupToDto. 
        // It's safer to bypass domain mapping if we just want to write DTOs, 
        // but our interface methods are saveGroup(ChatGroup).
          
        // Workaround: Reconstruct domain object manually or create a rawSave.
        // Since this is "restore", we trust the DTO structure.
        // Let's parse strictly to ensure validity.
          
        // Actually, mapGroupToDto requires 'index'. 
        // Let's implement a direct raw write for migration to avoid mapping roundtrips overhead/complexity
        // OR adapt the mapper. 
          
        // Let's do raw write logic here for efficiency and precision.
        const groups = await this.listGroupsRaw();
        groups.push(chunk.data);
        localStorage.setItem(KEY_GROUPS, JSON.stringify(groups));
        break;
      }
      case 'chat': {
        // Similar raw write strategy for chats
        const validated = DtoChatSchema.parse(chunk.data);
        localStorage.setItem(`${KEY_PREFIX}chat:${validated.id}`, JSON.stringify(validated));
          
        const indexList = await this.listChatsRaw();
        indexList.push(validated);
        localStorage.setItem(KEY_INDEX, JSON.stringify(indexList));
        break;
      }
      default: {
        const _exhaustiveCheck: never = chunk;
        throw new Error(`Unhandled migration chunk type: ${JSON.stringify(_exhaustiveCheck)}`);
      }
      
      }
    }
  }
}