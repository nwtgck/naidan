import type { Chat, Settings, ChatGroup, SidebarItem, ChatSummary } from '../../models/types';
import type { IStorageProvider } from './interface';
import { LocalStorageProvider } from './local-storage';
import { OPFSStorageProvider } from './opfs-storage';
import { useGlobalEvents } from '../../composables/useGlobalEvents';
import { STORAGE_BOOTSTRAP_KEY } from '../../models/constants';

export class StorageService {
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

    const oldProvider = this.provider;
    let newProvider: IStorageProvider;

    // Initialize the target provider
    if (type === 'opfs' && typeof navigator.storage?.getDirectory === 'function') {
      newProvider = new OPFSStorageProvider();
    } else {
      newProvider = new LocalStorageProvider();
    }

    try {
      await newProvider.init();
      
      // Migrate data: Dump from old -> Restore to new
      console.log(`Migrating data from ${this.currentType} to ${type}...`);
      const dumpStream = oldProvider.dump();
      await newProvider.restore(dumpStream);
      
      // Commit switch only after successful migration
      this.provider = newProvider;
      this.currentType = type;

      // Persist active storage type for the next application load
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(STORAGE_BOOTSTRAP_KEY, type);
      }

      console.log('Storage migration completed successfully.');
    } catch (error) {
      console.error('Storage migration failed. Reverting to previous provider.', error);
      
      const { addErrorEvent } = useGlobalEvents();
      addErrorEvent({
        source: 'StorageService',
        message: 'Storage migration failed. Reverting to previous provider.',
        details: error instanceof Error ? error : new Error(String(error)),
      });

      // We simply don't update this.provider, so the app continues using the old one.
      throw error; // Re-throw so UI can handle/display error
    }
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