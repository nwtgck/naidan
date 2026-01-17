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

export interface Endpoint {
  type: EndpointType;
  url?: string;
  httpHeaders?: [string, string][];
}

export type MultimodalContent = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: string;
  content: string | MultimodalContent[];
}

export interface AttachmentBase {
  id: string;           // UUID (directory name)
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
}

export type Attachment = 
  | (AttachmentBase & { status: 'persisted' })
  | (AttachmentBase & { status: 'memory'; blob: Blob })
  | (AttachmentBase & { status: 'missing' });

export interface MessageNode {
  id: string;
  role: Role;
  content: string;
  attachments?: Attachment[];
  timestamp: number;
  thinking?: string;
  error?: string;
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

  endpoint?: Endpoint;
  modelId?: string;
  systemPrompt?: SystemPrompt;
  lmParameters?: LmParameters;
}

export interface Chat {
  id: string;
  title: string | null;
  groupId?: string | null;
  root: MessageBranch;
  currentLeafId?: string;
  
  createdAt: number;
  updatedAt: number;
  debugEnabled: boolean;
  
  // TODO: Refactor into atomic endpoint object (e.g. endpoint: { type, url, httpHeaders })
  // to ensure data consistency and prevent invalid states (e.g. type without URL).
  endpointType?: EndpointType;
  endpointUrl?: string;
  endpointHttpHeaders?: [string, string][];
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
  | { id: string; type: 'chat_group'; chatGroup: ChatGroup };

/**
 * Provider Profile
 * Represents a reusable template/preset for connection settings.
 * Profiles are used to quickly populate global settings or chat overrides,
 * but are NOT directly referenced during runtime request resolution.
 */
export interface ProviderProfile {
  id: string;
  name: string;
  endpointType: EndpointType;
  endpointUrl?: string;
  endpointHttpHeaders?: [string, string][];
  defaultModelId?: string;
  titleModelId?: string;
  systemPrompt?: string;
  lmParameters?: LmParameters;
}

export interface Settings {
  endpointType: EndpointType;
  endpointUrl?: string;
  endpointHttpHeaders?: [string, string][];
  defaultModelId?: string;
  titleModelId?: string;
  autoTitleEnabled: boolean;
  storageType: StorageType;
  providerProfiles: ProviderProfile[];
  heavyContentAlertDismissed?: boolean;
  systemPrompt?: string;
  lmParameters?: LmParameters;
}

export const DEFAULT_SETTINGS: Settings = {
  endpointType: 'openai',
  autoTitleEnabled: true,
  storageType: 'local',
  providerProfiles: [],
  heavyContentAlertDismissed: false,
};
