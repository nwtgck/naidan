import type { Chat, Settings } from '../../models/types';

export type ChatSummary = Pick<Chat, 'id' | 'title' | 'updatedAt'>;

export interface IStorageProvider {
  saveChat(chat: Chat): Promise<void>;
  loadChat(id: string): Promise<Chat | null>;
  listChats(): Promise<ChatSummary[]>;
  deleteChat(id: string): Promise<void>;
  
  saveSettings(settings: Settings): Promise<void>;
  loadSettings(): Promise<Settings | null>;
  
  init(): Promise<void>;
}
