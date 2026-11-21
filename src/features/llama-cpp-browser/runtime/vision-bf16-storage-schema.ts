import { z } from 'zod';
import { visionBf16StorageSchema } from '@/features/llama-cpp-browser/types';

export { visionBf16StorageSchema };
export type VisionBf16Storage = z.infer<typeof visionBf16StorageSchema>;
// The order of these enums matches the values of the v1 native ABI.
export const visionBf16CandidateSchema = z.enum(['unknown', 'reviewed', 'legacy-first', 'not-applicable', 'unreviewed']);
export type VisionBf16Candidate = z.infer<typeof visionBf16CandidateSchema>;
export const visionBf16LoadReportSchema = z.object({
  status: z.enum(['failed', 'succeeded', 'retention-refused']),
  reason: z.enum(['none', 'other', 'projector-unreviewed', 'weight-unreviewed', 'invalid-mode']),
  phase: z.enum(['unknown', 'preupload', 'context', 'complete']),
  cleanup: z.enum(['unknown', 'complete', 'not-required']),
}).strict();
export type VisionBf16LoadReport = z.infer<typeof visionBf16LoadReportSchema>;
export const visionBf16StorageObservationSchema = z.object({
  preference: z.enum(['default', ...visionBf16StorageSchema.options]),
  selectedMode: visionBf16StorageSchema.optional(),
  contextRequestedMode: visionBf16StorageSchema.optional(),
  capability: z.enum(['available', 'absent', 'incompatible']),
  status: z.enum(['selected', 'initialized', 'unavailable']),
  reason: z.enum(['default-retain', 'default-legacy-api-absent', 'explicit', 'api-absent-explicit-retain', 'api-incompatible', 'api-version', 'api-constant', 'native-export-missing', 'context-request-mismatch',
    'auto-diagnostics-unavailable', 'auto-review', 'auto-legacy', 'auto-retention-refused']).optional(),
  candidate: visionBf16CandidateSchema.optional(),
  initialMode: visionBf16StorageSchema.optional(),
  retentionRefusal: visionBf16LoadReportSchema.optional(),
  loadReport: visionBf16LoadReportSchema.optional(),
  apiVersion: z.number().int().nonnegative().max(4294967295).optional(),
  // Both the getter and this selection describe policy, never actual GPU placement.
  evidence: z.literal('requested-policy-only'),
}).strict();
export type VisionBf16StorageObservation = z.infer<typeof visionBf16StorageObservationSchema>;

/** Retain the decision and report of the resident load when capturing a reuse. */
export function captureVisionStorageObservation({ value, preference }: { value: Readonly<VisionBf16StorageObservation>, preference: VisionBf16Storage | undefined }): VisionBf16StorageObservation {
  return { ...value, preference: preference ?? 'default', reason: preference === undefined ? value.reason : 'explicit' };
}

export const TEST_ONLY = {
};
