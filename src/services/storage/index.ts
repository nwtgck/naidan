import type { Chat, Settings, ChatGroup } from '../../models/types';
import type { IStorageProvider, ChatSummary } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';

class StorageService {
  private provider: IStorageProvider;
  private currentType: 'local' | 'opfs' = 'local';

  constructor() {
    this.provider = new LocalStorageProvider();
  }

  async init(type: 'local' | 'opfs' = 'local') {
    this.currentType = type;
    if (type === 'opfs' && typeof navigator.storage?.getDirectory === 'function') {
      this.provider = new OPFSStorageProvider();
    } else {
      this.provider = new LocalStorageProvider();
    }
    await this.provider.init();
  }

  getCurrentType(): 'local' | 'opfs' {
    return this.currentType;
  }

  async switchProvider(type: 'local' | 'opfs') {
    if (this.currentType === type) return;
    await this.init(type);
  }

  // Chats
  async saveChat(chat: Chat, index: number): Promise<void> {
    return this.provider.saveChat(chat, index);
  }

  async loadChat(id: string): Promise<Chat | null> {
    return this.provider.loadChat(id);
  }

  async listChats(): Promise<ChatSummary[]> {
    return this.provider.listChats();
  }

  async deleteChat(id: string): Promise<void> {
    return this.provider.deleteChat(id);
  }

  // Groups
  async saveGroup(group: ChatGroup, index: number): Promise<void> {
    return this.provider.saveGroup(group, index);
  }

  async loadGroup(id: string): Promise<ChatGroup | null> {
    return this.provider.loadGroup(id);
  }

  async listGroups(): Promise<ChatGroup[]> {
    return this.provider.listGroups();
  }

  async deleteGroup(id: string): Promise<void> {
    return this.provider.deleteGroup(id);
  }

  // Settings
  async saveSettings(settings: Settings): Promise<void> {
    return this.provider.saveSettings(settings);
  }

  async loadSettings(): Promise<Settings | null> {
    return this.provider.loadSettings();
  }
}

export const storageService = new StorageService();
export type { ChatSummary };
