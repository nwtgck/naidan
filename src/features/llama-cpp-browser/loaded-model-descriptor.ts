import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const unsigned64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n);
/** Bounded native attributes only; no filename, user metadata, template, or prompt. */
export const loadedModelDescriptorSchema = z.object({
  source: z.literal('loaded-model-native-api'),
  architecture: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  fileType: count.optional(),
  trainingContextTokens: count.optional(),
  embeddingDimensions: count.optional(),
  layers: count.optional(),
  attentionHeads: count.optional(),
  keyValueHeads: count.optional(),
  slidingWindowTokens: count.optional(),
  parameterCount: unsigned64.optional(),
  tensorBytes: unsigned64.optional(),
}).strict();
export type LoadedModelDescriptor = z.infer<typeof loadedModelDescriptorSchema>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
