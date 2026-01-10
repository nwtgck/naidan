import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary } from '../../models/types';
import type { IStorageProvider } from './interface';
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

  // --- Domain Methods (leveraging base class implementations) ---

  async listChats(): Promise<ChatSummary[]> {
    return this.provider.listChats();
  }

  async listGroups(): Promise<ChatGroup[]> {
    return this.provider.listGroups();
  }

  async getSidebarStructure(): Promise<SidebarItem[]> {
    return this.provider.getSidebarStructure();
  }

  // --- Persistence Methods ---

  async saveChat(chat: Chat, index: number): Promise<void> {
    return this.provider.saveChat(chat, index);
  }

  async loadChat(id: string): Promise<Chat | null> {
    return this.provider.loadChat(id);
  }

  async deleteChat(id: string): Promise<void> {
    return this.provider.deleteChat(id);
  }

  async saveGroup(group: ChatGroup, index: number): Promise<void> {
    return this.provider.saveGroup(group, index);
  }

  async loadGroup(id: string): Promise<ChatGroup | null> {
    return this.provider.loadGroup(id);
  }

  async deleteGroup(id: string): Promise<void> {
    return this.provider.deleteGroup(id);
  }

  async saveSettings(settings: Settings): Promise<void> {
    return this.provider.saveSettings(settings);
  }

  async loadSettings(): Promise<Settings | null> {
    return this.provider.loadSettings();
  }

  async clearAll(): Promise<void> {
    return this.provider.clearAll();
  }
}

export const storageService = new StorageService();
export type { ChatSummary };