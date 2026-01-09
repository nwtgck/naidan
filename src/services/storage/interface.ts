import type { Chat, Settings, ChatGroup } from '../../models/types';

/**
 * ChatSummary is used for listing chats without loading full message history.
 * It includes the order for initial sorting by the storage provider.
 */
export type ChatSummary = Pick<Chat, 'id' | 'title' | 'updatedAt' | 'groupId'> & { order: number };

export interface IStorageProvider {
  init(): Promise<void>;
  
  // Chats
  saveChat(chat: Chat, index: number): Promise<void>;
  loadChat(id: string): Promise<Chat | null>;
  listChats(): Promise<ChatSummary[]>;
  deleteChat(id: string): Promise<void>;
  
  // Groups
  saveGroup(group: ChatGroup, index: number): Promise<void>;
  loadGroup(id: string): Promise<ChatGroup | null>;
  listGroups(): Promise<ChatGroup[]>;
  deleteGroup(id: string): Promise<void>;
  
  // Settings
  saveSettings(settings: Settings): Promise<void>;
  loadSettings(): Promise<Settings | null>;
}