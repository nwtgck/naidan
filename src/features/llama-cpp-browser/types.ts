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
  contextSize: z.number().int().min(128).max(32768),
}).strict();
export type RuntimeOptions = z.infer<typeof runtimeOptionsSchema>;
export const modelSchema = z.object({
  id: z.string().max(1024).regex(/^user\/[^/]+-GGUF\/[^/]+\.gguf$/i), name: z.string().min(1).max(512),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  importedAt: z.number().int().nonnegative(),
}).strict();
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
export type GenerateInput = {
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant', content: string }>,
  temperature: number, topP: number, maxTokens: number,
  presencePenalty: number, frequencyPenalty: number,
  stop: string[], options: RuntimeOptions,
};
export const generateInputSchema = z.object({
  model: z.string().min(1).max(512),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(1),
  temperature: z.number().min(0).max(10), topP: z.number().min(0).max(1),
  maxTokens: z.number().int().min(1).max(32768),
  presencePenalty: z.number().min(-2).max(2), frequencyPenalty: z.number().min(-2).max(2),
  stop: z.array(z.string().min(1).max(512)).max(32), options: runtimeOptionsSchema,
}).strict();
export const TEST_ONLY = {
};
