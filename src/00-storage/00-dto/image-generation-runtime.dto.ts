import { z } from 'zod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/zod/missingAsUndefined';

// Storage validates structure independently from the peer wire contract. The
// caller adapter must validate these values again before making a remote call.
const pathSchema = z.string().min(1).max(4096);
const fileSchema = z.strictObject({
  location: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('opfs'), path: pathSchema }),
    z.strictObject({ kind: z.literal('host'), directoryId: z.string().min(1).max(128), path: pathSchema }),
  ]),
  expected: z.strictObject({ size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), lastModified: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).optional(),
});
export const RemoteImageModelSelectionSchemaDto = z.strictObject({
  primary: z.strictObject({ slot: z.enum(['model', 'diffusion']), file: fileSchema }),
  components: z.array(z.strictObject({ slot: z.enum(['vae', 'clipL', 'clipG', 't5', 'lm']), file: fileSchema })).max(5)
    .refine(value => new Set(value.map(item => item.slot)).size === value.length),
  loras: z.array(z.strictObject({ file: fileSchema, strength: z.number().finite().min(-10).max(10) })).max(8),
});
export const ImageGenerationRuntimeSchemaDto = z.union([
  resolveMissingAsUndefined(z.strictObject({
    sourceCommit: z.string(),
    profile: z.enum(['webgpu-wasm32-asyncify', 'webgpu-wasm32-jspi', 'webgpu-wasm64-jspi']),
    weightResidency: z.enum(['auto', 'cpu', 'hybrid', 'disk', 'runtime']),
    gpuBudgetMiB: missingAsUndefined(z.number().finite().nonnegative()),
  })),
  resolveMissingAsUndefined(z.strictObject({
    profile: z.literal('naidan-rpc'),
    connectionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    peerId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    label: z.string().max(100),
    // An unfinished draft can exist before a model is selected. Actual
    // generation requires an explicit model selection at the RPC boundary.
    modelSelection: missingAsUndefined(RemoteImageModelSelectionSchemaDto),
  })),
]);
export type ImageGenerationRuntimeDto = z.infer<typeof ImageGenerationRuntimeSchemaDto>;
export const TEST_ONLY = {
};
