/**
 * Domain Definitions (Business Logic Layer)
 * 
 * These types represent the "ideal" model used by the UI and business logic.
 * They are intentionally kept clean of persistence constraints (DTOs) and
 * external validation libraries to ensure a stable and maintainable application core.
 */
// --- Domain Definitions (Business Logic Layer) ---

export type Role = 'user' | 'assistant' | 'system';
export type StorageType = 'local' | 'opfs';
export type EndpointType = 'openai' | 'ollama';

export interface MessageNode {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  thinking?: string;
  replies: MessageBranch;
}

export interface MessageBranch {
  items: MessageNode[];
}

export interface ChatGroup {
  id: string;
  name: string;
  isCollapsed: boolean;
  items: SidebarItem[]; // Order is defined by array index
  updatedAt: number;
}

export interface Chat {
  id: string;
  title: string | null;
  groupId?: string | null;
  root: MessageBranch;
  currentLeafId?: string;
  
  modelId: string;
  createdAt: number;
  updatedAt: number;
  debugEnabled: boolean;
  
  endpointType?: EndpointType;
  endpointUrl?: string;
  overrideModelId?: string;
  originChatId?: string;
  originMessageId?: string;
}

export type ChatSummary = Pick<Chat, 'id' | 'title' | 'updatedAt' | 'groupId'>;

// Sidebar hierarchy - order is implicit by position in array
export type SidebarItem = 
  | { id: string; type: 'chat'; chat: ChatSummary }
  | { id: string; type: 'group'; group: ChatGroup };

export interface Settings {
  endpointType: EndpointType;
  endpointUrl: string;
  defaultModelId?: string;
  titleModelId?: string;
  autoTitleEnabled: boolean;
  storageType: StorageType;
}

export const DEFAULT_SETTINGS: Settings = {
  endpointType: 'openai',
  endpointUrl: 'http://localhost:8282/v1',
  autoTitleEnabled: true,
  storageType: 'local',
};