import { z } from 'zod';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

export class ProductionResourceCandidateError extends Error {
  override readonly name = 'ProductionResourceCandidateError';
  constructor({ candidate, cause }: { candidate: TransformersJsProductionInvestigationCandidate; cause: unknown }) {
    super(`Cannot plan ${candidate.device}/${candidate.dtype}: selected resource configuration is invalid`, { cause });
  }
}

export const productionResourceCandidateFailureSchema = z.object({
  name: z.literal('ProductionResourceCandidateError'),
  message: z.string(),
}).strict();
export type ProductionResourceCandidateFailure = z.infer<typeof productionResourceCandidateFailureSchema>;

export const productionCandidateResourcePlanSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), paths: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ status: z.literal('planning-failed'), error: productionResourceCandidateFailureSchema }).strict(),
]);
export type ProductionCandidateResourcePlan = z.infer<typeof productionCandidateResourcePlanSchema>;

export const runtimeArtifactPreparationResultSchema = z.object({
  processor: z.enum(['tokenizer', 'gemma4-processor', 'qwen3_5-processor']),
  modelType: z.string().optional(),
  resourcePlansByCandidate: z.record(z.string(), productionCandidateResourcePlanSchema),
}).strict();

export const TEST_ONLY = {
};
