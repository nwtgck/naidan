import type { Chat, Settings } from '../../models/types';
import { ChatSchemaDto, SettingsSchemaDto } from '../../models/dto';
import { 
  chatToDomain,
  chatToDto,
  settingsToDomain,
  settingsToDto
} from '../../models/mappers';
import type { IStorageProvider, ChatSummary } from './interface';

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

  async saveChat(chat: Chat): Promise<void> {
    const dto = chatToDto(chat);
    const validated = ChatSchemaDto.parse(dto);
    const chatsDir = await this.getChatsDir();
    const fileHandle = await chatsDir.getFileHandle(`${chat.id}.json`, { create: true });
    
    // @ts-ignore - createWritable is standard but sometimes types are missing
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(validated));
    await writable.close();

    // Update index
    await this.updateIndex(chat);
  }

  private async updateIndex(chat: Chat): Promise<void> {
    await this.init();
    let index: ChatSummary[] = await this.listChats();
    
    const summary: ChatSummary = {
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt
    };

    const existingIndex = index.findIndex(c => c.id === chat.id);
    if (existingIndex >= 0) {
      index[existingIndex] = summary;
    } else {
      index.push(summary);
    }
    index.sort((a, b) => b.updatedAt - a.updatedAt);

    const fileHandle = await this.root!.getFileHandle('index.json', { create: true });
    // @ts-ignore
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(index));
    await writable.close();
  }

  async loadChat(id: string): Promise<Chat | null> {
    try {
      const chatsDir = await this.getChatsDir();
      const fileHandle = await chatsDir.getFileHandle(`${id}.json`);
      const file = await fileHandle.getFile();
      const text = await file.text();
      const json = JSON.parse(text);
      const dto = ChatSchemaDto.parse(json);
      return chatToDomain(dto);
    } catch (e) {
      console.error('Failed to load chat from OPFS', e);
      return null;
    }
  }

  async listChats(): Promise<ChatSummary[]> {
    await this.init();
    try {
      const fileHandle = await this.root!.getFileHandle('index.json');
      const file = await fileHandle.getFile();
      const text = await file.text();
      const json = JSON.parse(text);
      if (Array.isArray(json)) return json as ChatSummary[];
      return [];
    } catch (e) {
      // If index doesn't exist, return empty
      return [];
    }
  }

  async deleteChat(id: string): Promise<void> {
    try {
      const chatsDir = await this.getChatsDir();
      await chatsDir.removeEntry(`${id}.json`);
      
      let index = await this.listChats();
      index = index.filter(c => c.id !== id);
      
      const fileHandle = await this.root!.getFileHandle('index.json', { create: true });
      // @ts-ignore
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(index));
      await writable.close();
    } catch (e) {
      console.error('Failed to delete chat from OPFS', e);
    }
  }

  async saveSettings(settings: Settings): Promise<void> {
    await this.init();
    const dto = settingsToDto(settings);
    const validated = SettingsSchemaDto.parse(dto);
    const fileHandle = await this.root!.getFileHandle('settings.json', { create: true });
    // @ts-ignore
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
      const json = JSON.parse(text);
      const dto = SettingsSchemaDto.parse(json);
      return settingsToDomain(dto);
    } catch (e) {
      // console.error('Failed to load settings from OPFS', e); // Silent fail is fine if not exists
      return null;
    }
  }
}
