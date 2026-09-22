import { TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES } from '@/features/transformers-js/production-load-candidates';
import type { ModelSupportInvestigationCandidateFilePlan, ModelSupportInvestigationModelFilePlan } from '@/features/transformers-js/model-support-investigation/types';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

export interface ModelSupportInvestigationDownloadRuntimeCandidateSelection {
  candidateOrder: TransformersJsProductionInvestigationCandidate[];
  reusableCandidateOrderByRevision: Record<string, TransformersJsProductionInvestigationCandidate[]>;
  requiredModelPathsByCandidate: Record<string, string[]>;
}

function candidateKey({ candidate }: { candidate: TransformersJsProductionInvestigationCandidate }): string {
  return `${candidate.device}/${candidate.dtype}`;
}

function requiredModelPaths({ candidate }: { candidate: ModelSupportInvestigationCandidateFilePlan }): string[] {
  return (candidate.files ?? [])
    .filter(file => file.requirement === 'required' && (file.kind === 'core-onnx' || file.kind === 'external-data'))
    .map(file => file.path);
}

function cacheContainsRequiredCandidateFiles({
  candidate,
  revision,
}: {
  candidate: ModelSupportInvestigationCandidateFilePlan;
  revision: string;
}): boolean {
  const requiredFiles = (candidate.files ?? []).filter(file => file.requirement === 'required');
  if (requiredFiles.length === 0) return false;
  return requiredFiles.every(file => file.cacheMatches.some(match => (
    match.path === `resolve/${revision}/${file.path}`
    && match.hasCompletionMarker
    && match.size > 0
    && (file.repositorySize === undefined || match.size === file.repositorySize)
  )));
}

export function selectDownloadRuntimeCandidates({
  modelFilePlan,
}: {
  modelFilePlan: ModelSupportInvestigationModelFilePlan;
}): ModelSupportInvestigationDownloadRuntimeCandidateSelection {
  const plannedByCandidate = new Map(modelFilePlan.candidates.map(candidate => [
    candidateKey({ candidate }),
    candidate,
  ]));
  const candidateOrder = TRANSFORMERS_JS_PRODUCTION_LOAD_CANDIDATES.filter(candidate => (
    plannedByCandidate.get(candidateKey({ candidate }))?.eligibility === 'eligible'
  ));
  const requiredModelPathsByCandidate = Object.fromEntries(candidateOrder.map(candidate => {
    const planned = plannedByCandidate.get(candidateKey({ candidate }));
    return [candidateKey({ candidate }), planned === undefined ? [] : requiredModelPaths({ candidate: planned })];
  }));

  const revisions = new Set<string>([modelFilePlan.resolvedRevision, 'main']);
  const reusableCandidateOrderByRevision: Record<string, TransformersJsProductionInvestigationCandidate[]> = {};
  for (const revision of revisions) {
    reusableCandidateOrderByRevision[revision] = candidateOrder.filter(candidate => {
      const planned = plannedByCandidate.get(candidateKey({ candidate }));
      return planned !== undefined && cacheContainsRequiredCandidateFiles({ candidate: planned, revision });
    });
  }

  return {
    candidateOrder: [...candidateOrder],
    reusableCandidateOrderByRevision,
    requiredModelPathsByCandidate,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  cacheContainsRequiredCandidateFiles,
  requiredModelPaths,
};
