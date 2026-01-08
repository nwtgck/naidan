/**
 * DTO (Data Transfer Objects) Definitions
 * 
 * These schemas and types represent the data as it is persisted or transmitted.
 * They are decoupled from the Domain layer to allow the persistence format to evolve
 * (handling historical baggage or legacy constraints) without polluting business logic.
 * 
 * CRITICAL: When evolving these schemas, backward compatibility MUST be maintained
 * to ensure that existing user data can still be read. Use Zod's .optional(), 
 * .default(), or .catch() to handle legacy fields during transformation.
 * 
 * IMPORTANT: Every time you add a feature or change these schemas, you MUST add
 * a new snapshot test case to `src/models/backward-compatibility.test.ts` to
 * verify that old data remains readable.
 * 
 * All persistence-level validation is handled here via Zod.
 */
import { z } from 'zod';

export const RoleSchemaDto = z.enum(['user', 'assistant', 'system']);
export type RoleDto = z.infer<typeof RoleSchemaDto>;

export const StorageTypeSchemaDto = z.enum(['local', 'opfs']);
export type StorageTypeDto = z.infer<typeof StorageTypeSchemaDto>;

export const EndpointTypeSchemaDto = z.enum(['openai', 'ollama']);
export type EndpointTypeDto = z.infer<typeof EndpointTypeSchemaDto>;

export const MessageSchemaDto = z.object({
  id: z.uuid(),
  role: RoleSchemaDto,
  content: z.string(),
  timestamp: z.number(),
  thinking: z.string().optional(),
});
export type MessageDto = z.infer<typeof MessageSchemaDto>;

export const ChatSchemaDto = z.object({
  id: z.uuid(),
  title: z.string(),
  messages: z.array(MessageSchemaDto),
  modelId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  debugEnabled: z.boolean().optional().default(false),
  // Overrides
  endpointType: EndpointTypeSchemaDto.optional(),
  endpointUrl: z.string().url().optional(),
  overrideModelId: z.string().optional(),
});
export type ChatDto = z.infer<typeof ChatSchemaDto>;

export const SettingsSchemaDto = z.object({
  endpointType: EndpointTypeSchemaDto,
  endpointUrl: z.string().url(),
  defaultModelId: z.string().optional(),
  storageType: StorageTypeSchemaDto,
});
export type SettingsDto = z.infer<typeof SettingsSchemaDto>;
