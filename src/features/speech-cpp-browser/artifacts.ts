import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const speechProfileSchema = z.enum(['webgpu-wasm32-jspi', 'webgpu-wasm64-jspi']);

export function speechPointerBytes({ profile }: { profile: z.infer<typeof speechProfileSchema> }): 4 | 8 {
  switch (profile) {
  case 'webgpu-wasm32-jspi': return 4;
  case 'webgpu-wasm64-jspi': return 8;
  default: {
    const exhaustive: never = profile;
    throw new Error(String(exhaustive));
  }
  }
}

export const speechArtifactSchema = z.object({
  profile: speechProfileSchema,
  modulePath: z.string(),
  wasmPath: z.string(),
  helpersPath: z.string(),
  schemaSha256: hash,
  wasmSha256: hash,
  wasmBytes: z.number().int().positive().max(100 * 1024 * 1024),
});
export type SpeechArtifact = z.infer<typeof speechArtifactSchema>;
export const speechConfigurationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unavailable'), reason: z.enum(['artifact_unavailable', 'standalone']) }),
  z.object({ kind: z.literal('available'), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), artifact: speechArtifactSchema }),
]);
export type SpeechConfiguration = z.infer<typeof speechConfigurationSchema>;

export const TEST_ONLY = {
};
