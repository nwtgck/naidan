import type { Chat, Settings } from '../../models/types';
import type { IStorageProvider, ChatSummary } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';

const STORAGE_PREF_KEY = 'lm-web-ui:storage-preference';

export class StorageService implements IStorageProvider {
  private provider: IStorageProvider;
  private currentType: 'local' | 'opfs';

  constructor() {
    // Default to local
    this.currentType = 'local';
    this.provider = new LocalStorageProvider();
  }

  async init(): Promise<void> {
    const savedPref = localStorage.getItem(STORAGE_PREF_KEY);
    if (savedPref === 'opfs') {
      this.currentType = 'opfs';
      this.provider = new OPFSStorageProvider();
    } else {
      this.currentType = 'local';
      this.provider = new LocalStorageProvider();
    }
    await this.provider.init();
  }

  async switchProvider(type: 'local' | 'opfs'): Promise<void> {
    if (this.currentType === type) return;

    this.currentType = type;
    localStorage.setItem(STORAGE_PREF_KEY, type);
    
    if (type === 'opfs') {
      this.provider = new OPFSStorageProvider();
    } else {
      this.provider = new LocalStorageProvider();
    }
    await this.provider.init();
  }

  getCurrentType(): 'local' | 'opfs' {
    return this.currentType;
  }

  // Delegate methods
  async saveChat(chat: Chat): Promise<void> {
    return this.provider.saveChat(chat);
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

  async saveSettings(settings: Settings): Promise<void> {
    return this.provider.saveSettings(settings);
  }

  async loadSettings(): Promise<Settings | null> {
    return this.provider.loadSettings();
  }
}

export const storageService = new StorageService();
