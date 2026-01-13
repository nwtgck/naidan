/**
 * Domain Definitions (Single Source of Truth)
 * 
 * These models represent the definitive state used by the UI and business logic.
 * They are strictly decoupled from DTOs to prevent persistence details from 
 * leaking into the core, ensuring structural integrity and preventing data 
 * inconsistencies.
 */
// --- Domain Definitions (Business Logic Layer) ---

export type Role = 'user' | 'assistant' | 'system';
export type StorageType = 'local' | 'opfs';
export type EndpointType = 'openai' | 'ollama';

export interface LmParameters {
  temperature?: number;
  topP?: number;
  maxCompletionTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string[];
}

export interface SystemPrompt {
  content: string;
  behavior: 'override' | 'append';
}

export interface MessageNode {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  thinking?: string;
  modelId?: string;
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

  systemPrompt?: SystemPrompt;
  lmParameters?: LmParameters;
}

export type ChatSummary = Pick<Chat, 'id' | 'title' | 'updatedAt' | 'groupId'>;

// Sidebar hierarchy - order is implicit by position in array
export type SidebarItem = 
  | { id: string; type: 'chat'; chat: ChatSummary }
  | { id: string; type: 'group'; group: ChatGroup };

export interface ProviderProfile {
  id: string;
  name: string;
  endpointType: EndpointType;
  endpointUrl?: string;
  defaultModelId?: string;
  titleModelId?: string;
  systemPrompt?: string;
  lmParameters?: LmParameters;
}

export interface Settings {
  endpointType: EndpointType;
  endpointUrl?: string;
  defaultModelId?: string;
  titleModelId?: string;
  autoTitleEnabled: boolean;
  storageType: StorageType;
  providerProfiles: ProviderProfile[];
  systemPrompt?: string;
  lmParameters?: LmParameters;
}

export const DEFAULT_SETTINGS: Settings = {
  endpointType: 'openai',
  autoTitleEnabled: true,
  storageType: 'local',
  providerProfiles: [],
};
