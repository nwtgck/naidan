import { z } from 'zod';

export const backendCensusSchema = z.object({
  version: z.literal(1),
  method: z.literal('native-eval-metadata'),
  timing: z.literal('not-a-speed-measurement'),
  // Destination storage and capability are observations, not scheduler IDs.
  placementMeaning: z.literal('destination-buffer-not-execution-backend'),
  // Missing in v3 archives: do not infer capabilities retrospectively.
  capability: z.enum(['synchronous-leaf-bindings-v1', 'legacy-synchronous-getters', 'tensor-layout-only']).optional(),
  observedNodes: z.number().int().nonnegative(),
  droppedNodes: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  entries: z.array(z.object({
    phase: z.enum(['setup', 'prefill', 'decode', 'other']),
    description: z.string().max(96),
    compute: z.boolean(),
    op: z.string().max(96),
    type: z.string().max(96),
    shape: z.array(z.number().int().nonnegative()).length(4),
    inputs: z.array(z.object({ type: z.string().max(96), shape: z.array(z.number().int().nonnegative()).length(4) }).strict()).max(2),
    buffer: z.string().max(160),
    storage: z.enum(['host', 'device', 'unknown']),
    webgpuSupport: z.enum(['supported', 'unsupported', 'unavailable']),
    metadataOnly: z.boolean(),
    nodes: z.number().int().positive(),
    examples: z.array(z.string().max(96)).max(3),
  }).strict()).max(2048),
}).strict();
export type BackendCensus = z.infer<typeof backendCensusSchema>;
export const TEST_ONLY = {
};
