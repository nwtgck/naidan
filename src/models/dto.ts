/**
 * DTO (Data Transfer Objects) Definitions
 * 
 * These schemas and types represent the data as it is persisted or transmitted.
 * They are decoupled from the Domain layer to allow the persistence format to evolve
 * (handling historical baggage or legacy constraints) without polluting business logic.
 * All persistence-level validation is handled here via Zod.
 */
import { z } from 'zod';

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
