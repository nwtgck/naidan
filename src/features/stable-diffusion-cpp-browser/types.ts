import { z } from 'zod';
import { profileOptions, samplerOptions, schedulerOptions } from './form-options';

export const profileSchema = z.enum(profileOptions);
export function getProfileConfiguration({ profile }: { profile: z.infer<typeof profileSchema> }): { pointerBytes: 4 | 8, memory64: boolean, jspi: boolean, suspension: 'direct' | 'asyncify' } {
  switch (profile) {
  case 'webgpu-wasm32-asyncify': return { pointerBytes: 4, memory64: false, jspi: false, suspension: 'asyncify' };
  case 'webgpu-wasm32-jspi': return { pointerBytes: 4, memory64: false, jspi: true, suspension: 'direct' };
  case 'webgpu-wasm64-jspi': return { pointerBytes: 8, memory64: true, jspi: true, suspension: 'direct' };
  default: { const exhaustive: never = profile; throw new Error(String(exhaustive)); }
  }
}
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const artifactSchema = z.object({
  profile: profileSchema,
  modulePath: z.string().regex(/^stable-diffusion-cpp-runtime\/[0-9a-f]{40}\/[a-z0-9-]+\/core\.mjs$/),
  wasmPath: z.string().regex(/^stable-diffusion-cpp-runtime\/[0-9a-f]{40}\/[a-z0-9-]+\/core\.wasm\.gz$/),
  helpersPath: z.string().regex(/^stable-diffusion-cpp-runtime\/[0-9a-f]{40}\/examples\/runtime\/index\.mjs$/),
  schemaSha256: hashSchema,
  wasmBytes: z.number().int().positive().max(100 * 1024 * 1024),
  wasmSha256: hashSchema,
}).superRefine((value, context) => {
  const prefix = value.modulePath.slice(0, value.modulePath.lastIndexOf('/') + 1);
  const sourcePrefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf('/') + 1);
  if (!value.modulePath.endsWith('/' + value.profile + '/core.mjs') || value.wasmPath !== prefix + 'core.wasm.gz' || value.helpersPath !== sourcePrefix + 'examples/runtime/index.mjs') {
    context.addIssue({ code: 'custom', message: 'Image runtime members must share a source and profile' });
  }
});
export const configurationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['not-installed', 'standalone']) }),
  z.object({ kind: z.literal('available'), sourceCommit: z.string().regex(/^[0-9a-f]{40}$/), artifacts: z.array(artifactSchema).min(1) }),
]);
export const samplerSchema = z.enum(samplerOptions);
export const schedulerSchema = z.enum(schedulerOptions);
export const parametersSchema = z.object({
  prompt: z.string().trim().min(1).max(4096).refine(value => !value.includes('\0')),
  negativePrompt: z.string().max(4096).refine(value => !value.includes('\0')),
  width: z.number().int().min(128).max(2048).multipleOf(64),
  height: z.number().int().min(128).max(2048).multipleOf(64),
  steps: z.number().int().min(1).max(100),
  guidance: z.number().min(0).max(30),
  // Keep the exact signed 64-bit value through the form and Worker transport.
  seed: z.string().max(20).regex(/^-?(0|[1-9][0-9]*)$/).pipe(z.string().refine(value => BigInt(value) >= -1n && BigInt(value) <= 9223372036854775807n)),
  sampler: samplerSchema,
  scheduler: schedulerSchema,
  distilledGuidance: z.number().min(0).max(30),
  vaeTiling: z.boolean(),
  vaeTileSize: z.number().int().min(16).max(256).multipleOf(8),
  flashAttention: z.boolean(),
  conditioningCacheSize: z.number().int().min(0).max(32),
  modelArguments: z.string().max(4096).refine(value => !value.includes('\0')),

});
export const modelSlotSchema = z.enum(['model', 'diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm']);
export const modelFileSchema = z.object({
  slot: modelSlotSchema,
  file: z.custom<File>(value => typeof File !== 'undefined' && value instanceof File && Number.isSafeInteger(value.size) && value.size >= 24 && /\.gguf$/i.test(value.name) && !/-[0-9]{5}-of-[0-9]{5}\.gguf$/i.test(value.name), 'Choose one complete, unsharded GGUF per component'),
});
export const requestSchema = z.object({
  artifact: artifactSchema,
  // The application supplies its own base, never a model-controlled URL.
  baseUrl: z.string().url(),
  models: z.array(modelFileSchema).min(1).max(7).superRefine((models, ctx) => {
    const slots = new Set(models.map(model => model.slot));
    if (slots.size !== models.length || slots.has('model') === slots.has('diffusion')) {
      ctx.addIssue({ code: 'custom', message: 'Choose one checkpoint OR one diffusion model, without duplicate slots' });
    }
  }),
  parameters: parametersSchema,
  gpuBudgetMiB: z.number().int().min(512).max(16384),
}).refine(value => getProfileConfiguration({ profile: value.artifact.profile }).memory64 || value.gpuBudgetMiB <= 4095, { path: ['gpuBudgetMiB'], message: 'The Wasm32 memory accounting budget must be below 4 GiB' });
export const progressSchema = z.object({
  phase: z.enum(['runtime', 'model', 'sampling', 'encoding']),
  step: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
});
export const responseSchema = z.object({
  png: z.custom<Blob>(value => typeof Blob !== 'undefined' && value instanceof Blob && value.type === 'image/png' && value.size > 0 && value.size < 32 * 1024 * 1024),
  width: z.number().int().min(128).max(2048),
  height: z.number().int().min(128).max(2048),
  modelVersion: z.string().max(256),
});
export type Artifact = z.infer<typeof artifactSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
export type Parameters = z.infer<typeof parametersSchema>;
export type ModelSlot = z.infer<typeof modelSlotSchema>;
export type Request = z.infer<typeof requestSchema>;
export type Progress = z.infer<typeof progressSchema>;
export type Response = z.infer<typeof responseSchema>;
export const TEST_ONLY = {
};
