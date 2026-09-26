import { z } from 'zod';
import { validModelPath } from './logic/model-path';
import { profileOptions, samplerOptions, schedulerOptions, defaultPreviewSettings } from './form-options';
export { defaultPreviewSettings } from './form-options';

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
export const previewSettingsSchema = z.object({
  enabled: z.boolean(),
  interval: z.number().int().min(1).max(100),
  mode: z.enum(['projection', 'vae']),
  maxEdge: z.union([z.literal(0), z.number().int().min(64).max(2048)]),
}).strict();
export type PreviewSettings = z.infer<typeof previewSettingsSchema>;
export const previewControlSchema = z.object({
  type: z.literal('naidan-image-preview-control-v1'),
  runId: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  settings: previewSettingsSchema,
}).strict();
export const previewFrameSchema = z.object({
  type: z.literal('naidan-image-preview-v1'),
  runId: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  step: z.number().int().min(1).max(100),
  steps: z.number().int().min(1).max(100),
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  mode: z.enum(['projection', 'vae']),
  png: z.custom<Blob>(value => typeof Blob !== 'undefined' && value instanceof Blob && value.type === 'image/png' && value.size > 0 && value.size < 32 * 1024 * 1024),
}).strict();
export type PreviewFrame = z.infer<typeof previewFrameSchema>;
export type PreviewControl = z.infer<typeof previewControlSchema>;

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
  qwenVaePolicy: z.enum(['bounded', 'native']).default('bounded'),
  conditioningCacheSize: z.number().int().min(0).max(32),
  modelArguments: z.string().max(4096).refine(value => !value.includes('\0')),

});
export const weightResidencySchema = z.enum(['auto', 'cpu', 'hybrid', 'disk', 'runtime']);
export const modelSlotSchema = z.enum(['model', 'diffusion', 'vae', 'clipL', 'clipG', 't5', 'lm']);
const localFileSchema = z.custom<File>(value => typeof File !== 'undefined' && value instanceof File && Number.isSafeInteger(value.size) && value.size >= 8, 'Choose a local model weight or index file');
const relativePathSchema = z.string().refine(path => validModelPath({ path }));
export const modelFileSchema = z.object({
  slot: modelSlotSchema,
  // Issued only by the published local inventory; manual files use identity tokens in the client.
  sourceId: z.string().min(1).max(1024 * 1024).optional(),
  file: localFileSchema,
  // Relative paths preserve source filenames and index references. Each role
  // receives its own mount root, so identically named files cannot collide.
  path: relativePathSchema.optional(),
  companions: z.array(z.object({ path: relativePathSchema, file: localFileSchema })).max(1024).optional(),
}).superRefine((model, ctx) => {
  const paths = [model.path ?? model.file.name, ...(model.companions ?? []).map(file => file.path)];
  const unique = new Set(paths);
  if (unique.size !== paths.length || paths.some(path => !validModelPath({ path }))) ctx.addIssue({ code: 'custom', message: 'Model paths must be safe and unique' });
  for (const path of paths) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) {
      if (unique.has(parts.join('/'))) ctx.addIssue({ code: 'custom', message: 'Model file/directory path conflict' });
      parts.pop();
    }
  }
});
export const requestSchema = z.object({
  debug: z.enum(['off', 'on']).optional(),
  runId: z.number().int().nonnegative().default(0),
  // Set by the window owner before transport, not inferred from names in the Worker.
  sessionId: z.string().max(64).default(''),
  preview: previewSettingsSchema.default({ ...defaultPreviewSettings }),
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
  weightResidency: weightResidencySchema.default('auto'),
  // A GPU budget is not a Wasm heap limit. Bound only exact byte accounting;
  // the separate Wasm32 refinement reflects native size_t, not model file size.
  gpuBudgetMiB: z.number().int().min(512).max(Math.floor(Number.MAX_SAFE_INTEGER / 1024 ** 2)).optional(),
}).refine(value => value.gpuBudgetMiB === undefined || getProfileConfiguration({ profile: value.artifact.profile }).memory64 || value.gpuBudgetMiB <= 4095, { path: ['gpuBudgetMiB'], message: 'The Wasm32 memory accounting budget must be below 4 GiB' });
export const progressSchema = z.object({
  phase: z.enum(['runtime', 'model', 'sampling', 'decoding', 'encoding']),
  step: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
});
export const responseSchema = z.object({
  png: z.custom<Blob>(value => typeof Blob !== 'undefined' && value instanceof Blob && value.type === 'image/png' && value.size > 0 && value.size < 32 * 1024 * 1024),
  width: z.number().int().min(128).max(2048),
  height: z.number().int().min(128).max(2048),
  modelVersion: z.string().max(256),
  uniformOutput: z.boolean().default(false),
});
export type Artifact = z.infer<typeof artifactSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
export type Parameters = z.infer<typeof parametersSchema>;
export type WeightResidency = z.infer<typeof weightResidencySchema>;
export type ModelSlot = z.infer<typeof modelSlotSchema>;
export type Request = z.infer<typeof requestSchema>;
export type Progress = z.infer<typeof progressSchema>;
export type Response = z.infer<typeof responseSchema>;
export const TEST_ONLY = {
};
