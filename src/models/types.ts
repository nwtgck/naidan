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
export type EndpointType = 'openai' | 'ollama' | 'transformer_js';

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
  modelId?: string;
  originChatId?: string;
  originMessageId?: string;

  systemPrompt?: SystemPrompt;
  lmParameters?: LmParameters;
}

/**
 * Chat Metadata
 * Represents the configuration and state of a chat, excluding its messages.
 * Used for sidebar listing and lightweight synchronization.
 */
export interface ChatMeta {
  id: string;
  title: string | null;
  groupId?: string | null;
  currentLeafId?: string;
  createdAt: number;
  updatedAt: number;
  debugEnabled: boolean;
  endpoint?: Endpoint;
  modelId?: string;
  originChatId?: string;
  originMessageId?: string;
  systemPrompt?: SystemPrompt;
  lmParameters?: LmParameters;
}

/**
 * Chat Content
 * Represents the actual conversation data (the message tree).
 */
export interface ChatContent {
  root: MessageBranch;
  currentLeafId?: string;
}

export type ChatSummary = Pick<Chat, 'id' | 'title' | 'updatedAt' | 'groupId'>;

// Sidebar hierarchy - order is implicit by position in array
export type SidebarItem = 
  | { id: string; type: 'chat'; chat: ChatSummary }
  | { id: string; type: 'chat_group'; chatGroup: ChatGroup };

/**
 * Hierarchy (Source of Truth for Structure)
 * Used to persist the visual tree separate from data records.
 */
export interface HierarchyChatNode {
  type: 'chat';
  id: string;
}

export interface HierarchyChatGroupNode {
  type: 'chat_group';
  id: string;
  chat_ids: string[];
}

export type HierarchyNode = HierarchyChatNode | HierarchyChatGroupNode;

export interface Hierarchy {
  items: HierarchyNode[];
}

/**
 * Storage Snapshot
 * Represents a complete snapshot of the storage for migration or backup.
 */
export interface StorageSnapshot {
  structure: {
    settings: Settings;
    hierarchy: Hierarchy;
    chatMetas: ChatMeta[];
    chatGroups: ChatGroup[];
  };
  /**
   * Stream of heavy content (full message trees and binary attachments).
   * This is kept as a generator to manage memory efficiency.
   */
  contentStream: AsyncGenerator<import('./dto').MigrationChunkDto>;
}

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

export const DEFAULT_SETTINGS: Omit<Settings, 'storageType' | 'endpointType'> = {
  autoTitleEnabled: true,
  providerProfiles: [],
  heavyContentAlertDismissed: false,
};
