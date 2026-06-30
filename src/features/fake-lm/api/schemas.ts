import { z } from 'zod';

const FakeLmThinkingSchema = z.union([
  z.boolean(),
  z.string(),
  z.object({
    effort: z.unknown().optional(),
  }).passthrough(),
]);

export const FakeLmOpenAiMessageSchema = z.object({
  role: z.string(),
  content: z.unknown().optional(),
}).passthrough();

export const FakeLmOpenAiChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(FakeLmOpenAiMessageSchema),
  stream: z.boolean().optional(),
  thinking: FakeLmThinkingSchema.optional(),
  reasoning: z.object({
    effort: z.unknown().optional(),
  }).passthrough().optional(),
  reasoning_effort: z.unknown().optional(),
}).passthrough();

export const FakeLmOllamaMessageSchema = z.object({
  role: z.string(),
  content: z.string().optional(),
}).passthrough();

export const FakeLmOllamaChatRequestSchema = z.object({
  model: z.string(),
  messages: z.array(FakeLmOllamaMessageSchema),
  stream: z.boolean().optional(),
  think: z.union([z.boolean(), z.string()]).optional(),
  thinking: FakeLmThinkingSchema.optional(),
}).passthrough();

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
