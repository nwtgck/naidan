import { z } from 'zod';
import { errorCodeSchema } from '@/features/llama-cpp-browser/types';
import { visionDiagnosticSchema } from './vision-diagnostic-schema';

const preparation = {
  version: z.literal(1),
  // Separate from the subsequent generation Worker's first-sample clock.
  elapsedMs: z.number().finite().nonnegative(),
  diagnostic: visionDiagnosticSchema,
};
export const visionAdmissionSchema = z.discriminatedUnion('status', [
  z.object({ ...preparation, status: z.literal('ready'), capability: z.enum(['native-vision', 'unknown-attempted-native']) }).strict(),
  z.object({ ...preparation, status: z.literal('skipped'), reason: z.enum(['missing-projector', 'native-no-vision']) }).strict(),
  z.object({ ...preparation, status: z.literal('failed'), error: errorCodeSchema }).strict(),
]);
export type VisionAdmission = z.infer<typeof visionAdmissionSchema>;

export const TEST_ONLY = {
};
