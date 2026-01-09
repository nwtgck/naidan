import type { 
  Chat, 
  Settings, 
  ChatGroup,
  ChatSummary,
  SidebarItem
} from '../../models/types';
import { 
  ChatSchemaDto as DtoChatSchema, 
  SettingsSchemaDto as DtoSettingsSchema,
  ChatGroupSchemaDto as DtoChatGroupSchema,
  type ChatGroupDto
} from '../../models/dto';
import { 
  chatToDomain as mapChatToDomain,
  chatToDto as mapChatToDto,
  chatGroupToDomain as mapGroupToDomain,
  chatGroupToDto as mapGroupToDto,
  settingsToDomain as mapSettingsToDomain,
  settingsToDto as mapSettingsToDto
} from '../../models/mappers';
import type { IStorageProvider } from './interface';

const KEY_PREFIX = 'lm-web-ui:';
const KEY_INDEX = `${KEY_PREFIX}index`;
const KEY_GROUPS = `${KEY_PREFIX}groups`;
const KEY_SETTINGS = `${KEY_PREFIX}settings`;

export class LocalStorageProvider implements IStorageProvider {
  async init(): Promise<void> {}

  async saveChat(chat: Chat): Promise<void> {
    const dto = mapChatToDto(chat);
    const validated = DtoChatSchema.parse(dto);
    localStorage.setItem(`${KEY_PREFIX}chat:${chat.id}`, JSON.stringify(validated));
    
    const index = await this.listChats();
    const existingIdx = index.findIndex(c => c.id === chat.id);
    const summary: ChatSummary = {
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      groupId: chat.groupId,
      order: chat.order
    };
    if (existingIdx >= 0) index[existingIdx] = summary;
    else index.push(summary);
    
    localStorage.setItem(KEY_INDEX, JSON.stringify(index));
  }

  async loadChat(id: string): Promise<Chat | null> {
    const raw = localStorage.getItem(`${KEY_PREFIX}chat:${id}`);
    if (!raw) return null;
    try {
      const dto = DtoChatSchema.parse(JSON.parse(raw));
      return mapChatToDomain(dto);
    } catch { return null; }
  }

  async listChats(): Promise<ChatSummary[]> {
    const raw = localStorage.getItem(KEY_INDEX);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as ChatSummary[];
    } catch { return []; }
  }

  async deleteChat(id: string): Promise<void> {
    localStorage.removeItem(`${KEY_PREFIX}chat:${id}`);
    const index = (await this.listChats()).filter(c => c.id !== id);
    localStorage.setItem(KEY_INDEX, JSON.stringify(index));
  }

  // --- Groups ---

  async saveGroup(group: ChatGroup): Promise<void> {
    const groups = await this.listGroups();
    const idx = groups.findIndex(g => g.id === group.id);
    
    // Use the order specified in the group object
    const order = group.order;
    
    const dto = mapGroupToDto(group, order);
    DtoChatGroupSchema.parse(dto);

    if (idx >= 0) {
      groups[idx] = { ...group, order };
    } else {
      groups.push({ ...group, order });
    }
    
    // Ensure the entire list is persisted with their current order
    const dtos = groups.map((g) => mapGroupToDto(g, g.order));
    localStorage.setItem(KEY_GROUPS, JSON.stringify(dtos));
  }

  async loadGroup(id: string): Promise<ChatGroup | null> {
    const groups = await this.listGroups();
    return groups.find(g => g.id === id) || null;
  }

  async listGroups(): Promise<ChatGroup[]> {
    const rawGroups = localStorage.getItem(KEY_GROUPS);
    if (!rawGroups) return [];
    const allChats = await this.listChats();
    
    try {
      const dtos = JSON.parse(rawGroups) as ChatGroupDto[];
      return dtos
        .sort((a, b) => a.order - b.order)
        .map(dto => {
          const validated = DtoChatGroupSchema.parse(dto);
          const groupChats = allChats.filter(c => c.groupId === validated.id);
          const nestedItems: SidebarItem[] = groupChats.map(c => ({
            id: `chat:${c.id}`,
            type: 'chat',
            chat: c,
            order: c.order
          }));
          return mapGroupToDomain(validated, nestedItems);
        });
    } catch { return []; }
  }

  async deleteGroup(id: string): Promise<void> {
    const rawGroups = localStorage.getItem(KEY_GROUPS);
    if (!rawGroups) return;
    const dtos = (JSON.parse(rawGroups) as ChatGroupDto[]).filter(g => g.id !== id);
    localStorage.setItem(KEY_GROUPS, JSON.stringify(dtos));
    
    const index = await this.listChats();
    for (const chatSummary of index) {
      if (chatSummary.groupId === id) {
        const chat = await this.loadChat(chatSummary.id);
        if (chat) {
          chat.groupId = null;
          await this.saveChat(chat);
        }
      }
    }
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
}
