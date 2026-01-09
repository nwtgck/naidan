import type { Chat, Settings, ChatGroup, SidebarItem } from '../../models/types';
import { ChatSchemaDto, SettingsSchemaDto, ChatGroupSchemaDto, type ChatGroupDto } from '../../models/dto';
import { 
  chatToDomain,
  chatToDto,
  chatGroupToDomain,
  chatGroupToDto,
  settingsToDomain,
  settingsToDto
} from '../../models/mappers';
import type { IStorageProvider, ChatSummary } from './interface';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

export class OPFSStorageProvider implements IStorageProvider {
  private root: FileSystemDirectoryHandle | null = null;

  async init(): Promise<void> {
    if (!this.root) {
      this.root = await navigator.storage.getDirectory();
    }
  }

  private async getChatsDir(): Promise<FileSystemDirectoryHandle> {
    await this.init();
    return await this.root!.getDirectoryHandle('chats', { create: true });
  }

  private async getGroupsDir(): Promise<FileSystemDirectoryHandle> {
    await this.init();
    return await this.root!.getDirectoryHandle('groups', { create: true });
  }

  async saveChat(chat: Chat, index: number): Promise<void> {
    const dto = chatToDto(chat, index);
    ChatSchemaDto.parse(dto);
    const chatsDir = await this.getChatsDir();
    const fileHandle = await chatsDir.getFileHandle(`${chat.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
    await this.updateIndex(chat, index);
  }

  private async updateIndex(chat: Chat, index: number): Promise<void> {
    await this.init();
    const summaries: ChatSummary[] = await this.listChats();
    const summary: ChatSummary = {
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      groupId: chat.groupId,
      order: index
    };
    const existingIndex = summaries.findIndex(c => c.id === chat.id);
    if (existingIndex >= 0) summaries[existingIndex] = summary;
    else summaries.push(summary);
    
    const fileHandle = await this.root!.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(summaries));
    await writable.close();
  }

  async loadChat(id: string): Promise<Chat | null> {
    try {
      const chatsDir = await this.getChatsDir();
      const fileHandle = await chatsDir.getFileHandle(`${id}.json`);
      const file = await fileHandle.getFile();
      const text = await file.text();
      return chatToDomain(ChatSchemaDto.parse(JSON.parse(text)));
    } catch { return null; }
  }

  async listChats(): Promise<ChatSummary[]> {
    await this.init();
    try {
      const fileHandle = await this.root!.getFileHandle('index.json');
      const file = await fileHandle.getFile();
      const text = await file.text();
      const json = JSON.parse(text);
      if (Array.isArray(json)) {
        const summaries = json as ChatSummary[];
        return summaries.sort((a, b) => a.order - b.order);
      }
      return [];
    } catch { return []; }
  }

  async deleteChat(id: string): Promise<void> {
    try {
      const chatsDir = await this.getChatsDir();
      await chatsDir.removeEntry(`${id}.json`);
      const summaries = (await this.listChats()).filter(c => c.id !== id);
      const fileHandle = await this.root!.getFileHandle('index.json', { create: true }) as FileSystemFileHandleWithWritable;
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(summaries));
      await writable.close();
    } catch { /* ignore */ }
  }

  // --- Groups ---

  async saveGroup(group: ChatGroup, index: number): Promise<void> {
    const dto = chatGroupToDto(group, index);
    const groupsDir = await this.getGroupsDir();
    const fileHandle = await groupsDir.getFileHandle(`${group.id}.json`, { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(dto));
    await writable.close();
  }

  async loadGroup(id: string): Promise<ChatGroup | null> {
    const groups = await this.listGroups();
    return groups.find(g => g.id === id) || null;
  }

  async listGroups(): Promise<ChatGroup[]> {
    try {
      const groupsDir = await this.getGroupsDir();
      const allChats = await this.listChats();
      const dtos: ChatGroupDto[] = [];
      // @ts-expect-error: values() is missing in some types
      for await (const entry of groupsDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.json')) {
          const file = await entry.getFile();
          const text = await file.text();
          dtos.push(JSON.parse(text));
        }
      }
      return dtos
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map(dto => {
          const validated = ChatGroupSchemaDto.parse(dto);
          const groupChats = allChats.filter(c => c.groupId === validated.id);
          const nestedItems: SidebarItem[] = groupChats.map(c => ({
            id: `chat:${c.id}`,
            type: 'chat',
            chat: c
          }));
          return chatGroupToDomain(validated, nestedItems);
        });
    } catch { return []; }
  }

  async deleteGroup(id: string): Promise<void> {
    try {
      const groupsDir = await this.getGroupsDir();
      await groupsDir.removeEntry(`${id}.json`);
      const summaries = await this.listChats();
      for (const c of summaries) {
        if (c.groupId === id) {
          const chat = await this.loadChat(c.id);
          if (chat) {
            chat.groupId = null;
            await this.saveChat(chat, c.order);
          }
        }
      }
    } catch { /* ignore */ }
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.init();
    const dto = settingsToDto(settings);
    const validated = SettingsSchemaDto.parse(dto);
    const fileHandle = await this.root!.getFileHandle('settings.json', { create: true }) as FileSystemFileHandleWithWritable;
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(validated));
    await writable.close();
  }

  async loadSettings(): Promise<Settings | null> {
    await this.init();
    try {
      const fileHandle = await this.root!.getFileHandle('settings.json');
      const file = await fileHandle.getFile();
      const text = await file.text();
      return settingsToDomain(SettingsSchemaDto.parse(JSON.parse(text)));
    } catch { return null; }
  }
}
