import { z } from 'zod';

export const RoleSchema = z.enum(['user', 'assistant', 'system']);
export type Role = z.infer<typeof RoleSchema>;

export const MessageSchema = z.object({
  id: z.string().uuid(),
  role: RoleSchema,
  content: z.string(),
  timestamp: z.number(),
  thinking: z.string().optional(), // For <think> blocks
});
export type Message = z.infer<typeof MessageSchema>;

export const ChatSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  messages: z.array(MessageSchema),
  modelId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Chat = z.infer<typeof ChatSchema>;

export const StorageTypeSchema = z.enum(['local', 'opfs']);
export type StorageType = z.infer<typeof StorageTypeSchema>;

export const EndpointTypeSchema = z.enum(['openai', 'ollama']);
export type EndpointType = z.infer<typeof EndpointTypeSchema>;

export const SettingsSchema = z.object({
  endpointType: EndpointTypeSchema,
  endpointUrl: z.string().url(),
  defaultModelId: z.string().optional(),
  storageType: StorageTypeSchema,
  debugMode: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  endpointType: 'openai',
  endpointUrl: 'http://localhost:8282/v1', // Default for testing as per requirements
  storageType: 'local',
  debugMode: false,
};
