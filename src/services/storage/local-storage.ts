import { type Chat, type Settings, ChatSchema, SettingsSchema } from '../../models/types';
import type { IStorageProvider, ChatSummary } from './interface';

const KEY_PREFIX = 'local-ai-ui:';
const KEY_INDEX = `${KEY_PREFIX}index`;
const KEY_SETTINGS = `${KEY_PREFIX}settings`;

export class LocalStorageProvider implements IStorageProvider {
  async init(): Promise<void> {
    // No initialization needed for localStorage
  }

  async saveChat(chat: Chat): Promise<void> {
    // Validate first
    const validatedChat = ChatSchema.parse(chat);
    
    // Save Chat
    localStorage.setItem(`${KEY_PREFIX}chat:${chat.id}`, JSON.stringify(validatedChat));
    
    // Update Index
    const index = await this.listChats();
    const existingIndex = index.findIndex(c => c.id === chat.id);
    const summary: ChatSummary = {
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt
    };
    
    if (existingIndex >= 0) {
      index[existingIndex] = summary;
    } else {
      index.push(summary);
    }
    // Sort by updatedAt desc
    index.sort((a, b) => b.updatedAt - a.updatedAt);
    
    localStorage.setItem(KEY_INDEX, JSON.stringify(index));
  }

  async loadChat(id: string): Promise<Chat | null> {
    const raw = localStorage.getItem(`${KEY_PREFIX}chat:${id}`);
    if (!raw) return null;
    
    try {
      const json = JSON.parse(raw);
      return ChatSchema.parse(json);
    } catch (e) {
      console.error('Failed to parse chat from local storage', e);
      return null;
    }
  }

  async listChats(): Promise<ChatSummary[]> {
    const raw = localStorage.getItem(KEY_INDEX);
    if (!raw) return [];
    try {
      // We don't have a schema for summary list, but it's simple enough or we can define one.
      // For now, trust but verify basic structure if needed, but assuming internal consistency.
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list as ChatSummary[];
      return [];
    } catch {
      return [];
    }
  }

  async deleteChat(id: string): Promise<void> {
    localStorage.removeItem(`${KEY_PREFIX}chat:${id}`);
    const index = await this.listChats();
    const newIndex = index.filter(c => c.id !== id);
    localStorage.setItem(KEY_INDEX, JSON.stringify(newIndex));
  }

  async saveSettings(settings: Settings): Promise<void> {
    const validated = SettingsSchema.parse(settings);
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(validated));
  }

  async loadSettings(): Promise<Settings | null> {
    const raw = localStorage.getItem(KEY_SETTINGS);
    if (!raw) return null;
    try {
      return SettingsSchema.parse(JSON.parse(raw));
    } catch (e) {
      console.error('Failed to load settings', e);
      return null;
    }
  }
}
