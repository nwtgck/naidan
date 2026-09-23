import { z } from 'zod';
import { modelSchema, runtimeOptionsSchema } from '@/features/llama-cpp-browser/types';

export const MAX_REFERENCE_BYTES = 16 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
// Transport bound, not a shared model limit. Session allocation is capped by
// llama_model_n_ctx_train and may retry smaller contexts on allocation failure.
export const MAX_AUDIO_CONTEXT_TOKENS = 2147483647;
export const audioLanguageSchema = z.enum(['auto', 'default', 'en', 'ja', 'zh', 'de', 'it', 'pt', 'es', 'ko', 'fr', 'ru']);
export const audioBackendSchema = z.enum(['profile', 'cpu']);
export const audioGenerationInputSchema = z.object({
  model: modelSchema.shape.id,
  text: z.string().min(1).max(8192).refine(value => value.trim().length > 0 && !value.includes('\0')),
  reference: z.instanceof(Blob).refine(value => value.size > 0 && value.size <= MAX_REFERENCE_BYTES).optional(),
  language: audioLanguageSchema,
  audioBackend: audioBackendSchema,
  contextTokens: z.number().int().min(1024).max(MAX_AUDIO_CONTEXT_TOKENS),
  maxFrames: z.number().int().min(1).max(2048),
  temperature: z.number().finite().min(0).max(2),
  topK: z.number().int().min(1).max(256),
  topP: z.number().finite().gt(0).max(1),
  seed: z.number().int().min(0).max(4294967295),
  options: runtimeOptionsSchema,
  debug: z.enum(['off', 'on']),
}).strict();
export type AudioGenerationInput = z.infer<typeof audioGenerationInputSchema>;
export const audioGenerationResultSchema = z.object({
  wav: z.instanceof(Uint8Array).refine(value => value.byteLength > 44 && value.byteLength <= MAX_AUDIO_BYTES),
  sampleRate: z.number().int().positive().max(384000),
  samples: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  frames: z.number().int().positive().max(2048),
  finishReason: z.enum(['stop', 'frame-limit', 'context-limit']),
  pipeline: z.enum(['qwen3-tts', 'pocket-tts']),
}).strict();
export type AudioGenerationResult = z.infer<typeof audioGenerationResultSchema>;
export type AudioBackend = z.infer<typeof audioBackendSchema>;

export function defaultAudioParameters(): Omit<AudioGenerationInput, 'model' | 'text' | 'reference' | 'options' | 'debug'> {
  return { language: 'en', audioBackend: 'profile', contextTokens: 4096, maxFrames: 256, temperature: 0.9, topK: 50, topP: 1, seed: 4294967295 };
}
export const TEST_ONLY = {
};
