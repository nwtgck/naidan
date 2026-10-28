import { z } from 'zod';

export const visionBf16StorageSchema = z.enum(['legacy-expand', 'retain-checked']);
export type VisionBf16Storage = z.infer<typeof visionBf16StorageSchema>;
export const visionBf16StorageObservationSchema = z.object({
  preference: z.enum(['default', ...visionBf16StorageSchema.options]),
  selectedMode: visionBf16StorageSchema.optional(),
  contextRequestedMode: visionBf16StorageSchema.optional(),
  capability: z.enum(['available', 'absent', 'incompatible']),
  status: z.enum(['selected', 'initialized', 'unavailable']),
  reason: z.enum(['default-retain', 'default-legacy-api-absent', 'explicit', 'api-absent-explicit-retain', 'api-incompatible', 'api-version', 'api-constant', 'native-export-missing', 'context-request-mismatch']).optional(),
  apiVersion: z.number().int().nonnegative().max(4294967295).optional(),
  // Both the getter and this selection describe policy, never actual GPU placement.
  evidence: z.literal('requested-policy-only'),
}).strict();
export type VisionBf16StorageObservation = z.infer<typeof visionBf16StorageObservationSchema>;

/** Effective default from a previously checked projector capability. */
export function defaultVisionBf16Storage({ capability }: { capability: VisionBf16StorageObservation['capability'] }): VisionBf16Storage | undefined {
  switch (capability) {
  case 'available': return 'retain-checked';
  case 'absent': return 'legacy-expand';
  case 'incompatible': return undefined;
  default: {
    const exhaustive: never = capability;
    throw new Error(String(exhaustive));
  }
  }
}

/** A reused projector keeps its native policy, while this request may use a default. */
export function captureVisionStorageObservation({ value, preference }: { value: Readonly<VisionBf16StorageObservation>, preference: VisionBf16Storage | undefined }): VisionBf16StorageObservation {
  let reason: VisionBf16StorageObservation['reason'];
  switch (preference) {
  case 'legacy-expand': case 'retain-checked': reason = 'explicit';
    break;
  case undefined:
    switch (value.capability) {
    case 'available': reason = 'default-retain';
      break;
    case 'absent': reason = 'default-legacy-api-absent';
      break;
    case 'incompatible': reason = value.reason;
      break;
    default: {
      const exhaustive: never = value.capability;
      throw new Error(String(exhaustive));
    }
    }
    break;
  default: {
    const exhaustive: never = preference;
    throw new Error(String(exhaustive));
  }
  }
  return { ...value, preference: preference ?? 'default', reason };
}

export const TEST_ONLY = {
};
