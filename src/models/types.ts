import { z } from 'zod';

// --- DTO Definitions (Persistence Layer) ---

export const RoleSchemaDto = z.enum(['user', 'assistant', 'system']);
export type RoleDto = z.infer<typeof RoleSchemaDto>;

export const MessageSchemaDto = z.object({
  id: z.string().uuid(),
  role: RoleSchemaDto,
  content: z.string(),
  timestamp: z.number(),
  thinking: z.string().optional(),
});
export type MessageDto = z.infer<typeof MessageSchemaDto>;

export const ChatSchemaDto = z.object({
  id: z.string().uuid(),
  title: z.string(),
  messages: z.array(MessageSchemaDto),
  modelId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  debugEnabled: z.boolean().optional().default(false),
});
export type ChatDto = z.infer<typeof ChatSchemaDto>;

export const StorageTypeSchemaDto = z.enum(['local', 'opfs']);
export type StorageTypeDto = z.infer<typeof StorageTypeSchemaDto>;

export const EndpointTypeSchemaDto = z.enum(['openai', 'ollama']);
export type EndpointTypeDto = z.infer<typeof EndpointTypeSchemaDto>;

export const SettingsSchemaDto = z.object({
  endpointType: EndpointTypeSchemaDto,
  endpointUrl: z.string().url(),
  defaultModelId: z.string().optional(),
  storageType: StorageTypeSchemaDto,
});
export type SettingsDto = z.infer<typeof SettingsSchemaDto>;

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

// --- Mappers ---

export const roleToDomain = (dto: RoleDto): Role => {
  switch (dto) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'system': return 'system';
    default: throw new Error(`Unknown role: ${dto}`);
  }
};

export const messageToDomain = (dto: MessageDto): Message => ({
  id: dto.id,
  role: roleToDomain(dto.role),
  content: dto.content,
  timestamp: dto.timestamp,
  thinking: dto.thinking,
});

export const chatToDomain = (dto: ChatDto): Chat => ({
  id: dto.id,
  title: dto.title,
  messages: dto.messages.map(messageToDomain),
  modelId: dto.modelId,
  createdAt: dto.createdAt,
  updatedAt: dto.updatedAt,
  debugEnabled: dto.debugEnabled ?? false,
});

export const chatToDto = (domain: Chat): ChatDto => ({
  id: domain.id,
  title: domain.title,
  messages: domain.messages.map(m => ({
    id: m.id,
    role: m.role as RoleDto, // Explicit cast for DTO compatibility
    content: m.content,
    timestamp: m.timestamp,
    thinking: m.thinking,
  })),
  modelId: domain.modelId,
  createdAt: domain.createdAt,
  updatedAt: domain.updatedAt,
  debugEnabled: domain.debugEnabled,
});

export const settingsToDomain = (dto: SettingsDto): Settings => ({
  endpointType: dto.endpointType as EndpointType,
  endpointUrl: dto.endpointUrl,
  defaultModelId: dto.defaultModelId,
  storageType: dto.storageType as StorageType,
});

export const settingsToDto = (domain: Settings): SettingsDto => ({
  endpointType: domain.endpointType as EndpointTypeDto,
  endpointUrl: domain.endpointUrl,
  defaultModelId: domain.defaultModelId,
  storageType: domain.storageType as StorageTypeDto,
});


