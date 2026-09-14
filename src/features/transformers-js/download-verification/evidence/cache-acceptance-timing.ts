import { z } from 'zod';
import { downloadAcceptanceTimingSchema } from '@/features/transformers-js/download-timing';

export const CACHE_ACCEPTANCE_TIMING_EVIDENCE_PATH = 'download-lane/runtime-timing.json';
export const cacheAcceptanceTimingEvidenceSchema = z.object({
  format: z.literal('msi-cache-acceptance-timing-v1'),
  source: z.literal('current-msi-cache-acceptance'),
  runId: z.string().min(1).max(128),
  modelId: z.string().min(1).max(160),
  droppedObservations: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observations: z.array(downloadAcceptanceTimingSchema).max(128),
}).strict();
export type CacheAcceptanceTimingEvidence = z.infer<typeof cacheAcceptanceTimingEvidenceSchema>;

export const TEST_ONLY = {
};
