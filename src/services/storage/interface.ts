import type { Chat, Settings, ChatGroup, ChatSummary } from '../../models/types';

export type { ChatSummary };

export interface IStorageProvider {
  saveChat(chat: Chat): Promise<void>;
  loadChat(id: string): Promise<Chat | null>;
  listChats(): Promise<ChatSummary[]>;
  deleteChat(id: string): Promise<void>;
  
  saveGroup(group: ChatGroup): Promise<void>;
  loadGroup(id: string): Promise<ChatGroup | null>;
  listGroups(): Promise<ChatGroup[]>;
  deleteGroup(id: string): Promise<void>;
  
  saveSettings(settings: Settings): Promise<void>;
  loadSettings(): Promise<Settings | null>;
  
  init(): Promise<void>;
}
