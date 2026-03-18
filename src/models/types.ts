/**
 * Domain Definitions (Single Source of Truth)
 *
 * These models represent the definitive state used by the UI and business logic.
 * They are strictly decoupled from DTOs to prevent persistence details from
 * leaking into the core, ensuring structural integrity and preventing data
 * inconsistencies.
 */
import type { ToolExecutionResult } from '@/services/tools/types';

// --- Domain Definitions (Business Logic Layer) ---

export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type StorageType = 'local' | 'opfs' | 'memory';
export type EndpointType = 'openai' | 'ollama' | 'transformers_js';

export type Reasoning = {
  effort: 'none' | 'low' | 'medium' | 'high' | undefined;
};

export type LmParameters = {
  temperature: number | undefined;
  topP: number | undefined;
  maxCompletionTokens: number | undefined;
  presencePenalty: number | undefined;
  frequencyPenalty: number | undefined;
  stop: string[] | undefined;
  reasoning: Reasoning;
};

/**
 * Not named 'DEFAULT' because 'DEFAULT' usually implies specific fallback values
 * (e.g., temperature: 0.7), whereas this object represents a purely 'EMPTY' state
 * where all optional fields are explicitly initialized as 'undefined'.
 */
export const EMPTY_LM_PARAMETERS: LmParameters = {
  temperature: undefined,
  topP: undefined,
  maxCompletionTokens: undefined,
  presencePenalty: undefined,
  frequencyPenalty: undefined,
  stop: undefined,
  reasoning: { effort: undefined },
};

export type SystemPrompt =
  | { behavior: 'override'; content: string | null }
  | { behavior: 'append'; content: string };

export interface Endpoint {
  type: EndpointType;
  url?: string;
  httpHeaders?: [string, string][];
}

export type MultimodalContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: string;
  content: string | MultimodalContent[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface AttachmentBase {
  id: string;           // Attachment ID
  binaryObjectId: string; // Pointer to the immutable Binary Object
  originalName: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
}

export type Attachment =
  | (AttachmentBase & { status: 'persisted' })
  | (AttachmentBase & { status: 'memory'; blob: Blob })
  | (AttachmentBase & { status: 'missing' });

export type MessageNodeBase = {
  id: string;
  content: string | undefined;
  timestamp: number;
  replies: MessageBranch;
};

export type UserMessageNode = MessageNodeBase & {
  role: 'user';
  content: string;
  attachments?: Attachment[];
  thinking?: undefined;
  error?: undefined;
  modelId?: undefined;
  lmParameters?: LmParameters;
  toolCalls?: undefined;
  results?: undefined;
};

export type AssistantMessageNode = MessageNodeBase & {
  role: 'assistant';
  content: string;
  attachments?: undefined;
  thinking?: string;
  error?: string;
  modelId?: string;
  lmParameters?: LmParameters;
  toolCalls?: ToolCall[];
  results?: undefined;
};

export type SystemMessageNode = MessageNodeBase & {
  role: 'system';
  content: string;
  attachments?: undefined;
  thinking?: undefined;
  error?: undefined;
  modelId?: undefined;
  lmParameters?: undefined;
  toolCalls?: undefined;
  results?: undefined;
};

export type ToolMessageNode = MessageNodeBase & {
  role: 'tool';
  content: undefined;
  attachments: undefined;
  thinking: undefined;
  error: undefined;
  modelId: undefined;
  lmParameters: undefined;
  toolCalls: undefined;
  results: ToolExecutionResult[];
};

export type MessageNode = UserMessageNode | AssistantMessageNode | SystemMessageNode | ToolMessageNode;

export type MessageBranch = {
  items: MessageNode[];
};

export interface CombinedToolCall {
  id: string; // The toolCallId
  nodeId: string; // The ToolMessageNode's ID
  call: ToolCall;
  result: ToolExecutionResult;
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
  autoTitleEnabled?: boolean;
  titleModelId?: string;
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
  autoTitleEnabled?: boolean;
  titleModelId?: string;
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

export type ChatSidebarItem =
  | { id: string; type: 'chat'; chat: ChatSummary };

export interface ChatGroup {
  id: string;
  name: string;
  isCollapsed: boolean;
  items: ChatSidebarItem[]; // Order is defined by array index
  updatedAt: number;

  endpoint?: Endpoint;
  modelId?: string;
  autoTitleEnabled?: boolean;
  titleModelId?: string;
  systemPrompt?: SystemPrompt;
  lmParameters?: LmParameters;
}

// Sidebar hierarchy - order is implicit by position in array
export type SidebarItem =
  | ChatSidebarItem
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

export interface BinaryObject {
  id: string;
  mimeType: string;
  size: number;
  createdAt: number;
  name?: string;
}

export type VolumeType = 'opfs' | 'host';

export interface Volume {
  id: string;
  name: string;
  type: VolumeType;
  createdAt: number;
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
  experimental?: {
    markdownRendering: 'block_markdown' | 'monolithic_html';
  };
}

export const DEFAULT_SETTINGS: Omit<Settings, 'storageType' | 'endpointType'> = {
  autoTitleEnabled: true,
  providerProfiles: [],
  heavyContentAlertDismissed: false,
};
