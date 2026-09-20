import { z } from 'zod';

export const profileSchema = z.enum(['webgpu-wasm64-jspi', 'cpu-wasm64', 'cpu-wasm32']);
export type LlamaCppProfile = z.infer<typeof profileSchema>;
export function usesWebGpu({ profile }: { profile: LlamaCppProfile }): boolean {
  switch (profile) {
  case 'webgpu-wasm64-jspi': return true;
  case 'cpu-wasm32':
  case 'cpu-wasm64': return false;
  default: { const exhaustive: never = profile; throw new Error(`Unhandled profile: ${exhaustive}`); }
  }
}
export const runtimeOptionsSchema = z.object({
  profile: z.union([z.literal('auto'), profileSchema]),
}).strict();
export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;
export const modelSchema = z.object({
  id: z.string().min(1).max(1024).regex(/^(?!\.{1,2}$)(?:[^/\\]+|user\/[^/\\]+-GGUF\/[^/\\]+\.gguf)$/i).refine(value => !Array.from(value).some(character => character.charCodeAt(0) < 32)), name: z.string().min(1).max(512),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  importedAt: z.number().int().nonnegative(),
}).strict();
export const modelDirectoryInputSchema = z.object({ name: z.string().min(1), files: z.array(z.object({ path: z.string().min(1), file: z.instanceof(File) }).strict()).min(1) }).strict();
export type ModelDirectoryInput = z.infer<typeof modelDirectoryInputSchema>;
export type LocalModel = z.infer<typeof modelSchema>;
export const modelsSchema = z.array(modelSchema);
export const errorCodeSchema = z.enum([
  'unavailable', 'invalid-gguf', 'duplicate-model', 'missing-model', 'storage-error',
  'runtime-error', 'template-unsupported', 'context-full', 'unsupported-input',
  'busy', 'aborted', 'worker-failed',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export class LlamaCppBrowserError extends Error {
  constructor({ code }: { code: ErrorCode }) {
    super(`llama.cpp browser: ${code}`);
    this.name = 'LlamaCppBrowserError';
  }
}
export function errorCode({ error }: { error: unknown }): ErrorCode {
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted';
  if (error instanceof Error) {
    const parsed = errorCodeSchema.safeParse(error.message.startsWith('llama.cpp browser: ') ? error.message.slice('llama.cpp browser: '.length) : undefined);
    if (parsed.success) return parsed.data;
    if (error.name === 'AbortError') return 'aborted';
  }
  return 'runtime-error';
}
export const progressSchema = z.object({
  phase: z.enum(['importing', 'initializing', 'loading', 'prefill', 'generating']),
  completed: z.number().nonnegative().finite(), total: z.number().nonnegative().finite(),
}).strict();
export type Progress = z.infer<typeof progressSchema>;
export type EngineState =
  | { status: 'unavailable' }
  | { status: 'idle' }
  | { status: 'working', progress: Progress }
  | { status: 'error', code: ErrorCode };
export const toolCallSchema = z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }).strict() }).strict();
const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']), content: z.union([z.string(), z.array(z.discriminatedUnion('type', [z.object({ type: z.literal('text'), text: z.string() }).strict(), z.object({ type: z.literal('image'), blob: z.instanceof(Blob) }).strict()]))]),
  reasoning_content: z.string().optional(), tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(), name: z.string().optional(),
}).strict();
export const generationResultSchema = z.object({
  content: z.string(), reasoningContent: z.string(), toolCalls: z.array(toolCallSchema),
  finishReason: z.enum(['stop', 'length']),
}).strict();
export type GenerationResult = z.infer<typeof generationResultSchema>;
export type GenerateInput = z.infer<typeof generateInputSchema>;
export const generateInputSchema = z.object({
  debug: z.enum(['off', 'on']).optional(),
  model: z.string().min(1).max(512),
  messages: z.array(chatMessageSchema).min(1),
  tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1), description: z.string(), parameters: z.record(z.string(), z.json()) }).strict() }).strict()).optional(),
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(),
  temperature: z.number().min(0).max(10), topP: z.number().min(0).max(1),
  maxTokens: z.number().int().min(1).max(32768),
  presencePenalty: z.number().min(-2).max(2), frequencyPenalty: z.number().min(-2).max(2),
  stop: z.array(z.string().min(1).max(512)).max(32), options: runtimeOptionsSchema,
}).strict();
export const TEST_ONLY = {
};
