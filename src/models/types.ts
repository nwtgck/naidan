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

export interface Message {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  thinking?: string;
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
  modelId: string;
  createdAt: number;
  updatedAt: number;
  debugEnabled: boolean;
  endpointType?: EndpointType;
  endpointUrl?: string;
  overrideModelId?: string;
}

export interface Settings {
  endpointType: EndpointType;
  endpointUrl: string;
  defaultModelId?: string;
  storageType: StorageType;
}

export const DEFAULT_SETTINGS: Settings = {
  endpointType: 'openai',
  endpointUrl: 'http://localhost:8282/v1',
  storageType: 'local',
};