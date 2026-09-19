import { z } from 'zod';
import { productionLoadReceiptSchema, productionLoadReceiptRevisionOption } from '@/features/transformers-js/runtime/production-load-receipt';

/** Identity-only projection; other evidence fields have separate owners. */
export const downloadRuntimeAcceptanceIdentityInputSchema = z.object({
  run: z.object({ normalizedModelId: z.string(), resolvedRevision: z.string() }),
  runtimeCompletion: z.object({ status: z.enum(['accepted', 'failed', 'exhausted']), repositoryResolvedRevision: z.string(),
    cacheRevision: z.string().nullable(), loaderRevisionOption: z.string().nullable(),
    selectedCandidate: productionLoadReceiptSchema.shape.candidate.optional(), receipt: z.unknown().optional(),
  }).optional(),
  modelArtifactObservationError: z.string().optional(),
  modelArtifactObservations: z.array(z.object({ status: z.enum(['observed', 'failed']), modelId: z.string(), revision: z.string(),
    autoClass: productionLoadReceiptSchema.shape.autoClass, candidate: productionLoadReceiptSchema.shape.candidate,
    paths: z.array(z.string()), error: z.object({ name: z.string(), message: z.string() }).optional(),
  })),
});

/** Local runtime acceptance and frozen-repository correlation are distinct. */
export function downloadRuntimeAcceptanceIdentity({ evidence }: { evidence: z.infer<typeof downloadRuntimeAcceptanceIdentityInputSchema> }): 'exact-resolved-revision' | 'legacy-main-unverified' | 'unverified' | undefined {
  const completion = evidence.runtimeCompletion;
  if (completion === undefined || completion.status !== 'accepted') return undefined;
  const parsed = productionLoadReceiptSchema.safeParse(completion.receipt);
  // Older observations did not retain the common Load boundary receipt.
  if (!parsed.success) return 'unverified';
  const receipt = parsed.data;
  const loaderRevision = productionLoadReceiptRevisionOption({ option: receipt.loaderRevisionOption }) ?? null;
  if (receipt.modelId !== evidence.run.normalizedModelId || completion.repositoryResolvedRevision !== evidence.run.resolvedRevision
    || completion.cacheRevision !== receipt.cacheLookup.revision || completion.loaderRevisionOption !== loaderRevision
    || completion.selectedCandidate?.device !== receipt.candidate.device || completion.selectedCandidate.dtype !== receipt.candidate.dtype) return 'unverified';
  if (receipt.cacheLookup.revision === 'main') return 'legacy-main-unverified';
  if (!/^[a-f0-9]{40}$/u.test(receipt.cacheLookup.revision) || receipt.cacheLookup.revision !== evidence.run.resolvedRevision
    || loaderRevision !== evidence.run.resolvedRevision) return 'unverified';
  if (evidence.modelArtifactObservationError !== undefined) return 'unverified';
  const matching = evidence.modelArtifactObservations.filter(item => item.modelId === receipt.modelId && item.revision === evidence.run.resolvedRevision && item.autoClass === receipt.autoClass
    && item.candidate.device === receipt.candidate.device && item.candidate.dtype === receipt.candidate.dtype);
  const observation = matching[0];
  if (matching.length !== 1 || observation === undefined || observation.status !== 'observed' || observation.error !== undefined) return 'unverified';
  const planned = receipt.plannedRequiredPaths.filter(path => /\.onnx(?:_data(?:_\d+)?)?$/iu.test(path)).sort();
  const observed = [...new Set(observation.paths)].sort();
  if (planned.length === 0 || JSON.stringify(planned) !== JSON.stringify(observed)) return 'unverified';
  return 'exact-resolved-revision';
}

export const TEST_ONLY = {
};
