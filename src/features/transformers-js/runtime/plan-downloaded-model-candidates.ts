import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';
import { ProductionResourceCandidateError, type ProductionResourceCandidateFailure } from './production-resource-plan';
import { downloadedModelResourceUrl } from './downloaded-model-resource-url';

interface ReadOnlyModelCache {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the Cache API consumed by Transformers.js.
  match(request: string | Request): Promise<Response | undefined>;
}

export type DownloadedModelCandidatePlanEntry = {
  status: 'planning-failed';
  candidate: TransformersJsProductionInvestigationCandidate;
  error: ProductionResourceCandidateFailure;
} | {
  status: 'checked';
  candidate: TransformersJsProductionInvestigationCandidate;
  requiredModelPaths: string[];
  missingModelPaths: string[];
  requiredRuntimePaths: string[];
  missingRuntimePaths: string[];
  complete: boolean;
};

function candidateKey({ candidate }: {
  candidate: TransformersJsProductionInvestigationCandidate;
}): string {
  return `${candidate.device}/${candidate.dtype}`;
}

/**
 * Derives candidate completeness from the shared Production resource plan and
 * the existing OPFS files/`.complete` markers.
 *
 * This is intentionally recomputed instead of persisted as a Naidan-specific
 * manifest: the caller uses the versioned selector shared with Download,
 * while cache.match performs only OPFS metadata/file
 * lookups and does not consume multi-GB model bodies. Persisting a second plan
 * would create stale state that could disagree with either the runtime or OPFS.
 */
export async function planDownloadedModelCandidates({
  modelId,
  revision,
  candidates,
  modelCache,
  getModelFiles,
  getRuntimeFiles,
  workerLocationUrl,
}: {
  modelId: string;
  revision: string | undefined;
  candidates: readonly TransformersJsProductionInvestigationCandidate[];
  modelCache: ReadOnlyModelCache;
  getModelFiles: ({ candidate }: {
    candidate: TransformersJsProductionInvestigationCandidate;
  }) => Promise<string[]>;
  getRuntimeFiles: () => Promise<string[]>;
  workerLocationUrl: string;
}): Promise<DownloadedModelCandidatePlanEntry[]> {
  const pathCompleteness = new Map<string, boolean>();
  const entries: DownloadedModelCandidatePlanEntry[] = [];
  const requiredRuntimePaths = [...new Set(await getRuntimeFiles())]
    .sort((left, right) => left.localeCompare(right));

  for (const candidate of candidates) {
    let selectedPaths: string[];
    try {
      selectedPaths = await getModelFiles({ candidate });
    } catch (error) {
      if (!(error instanceof ProductionResourceCandidateError)) throw error;
      entries.push({
        status: 'planning-failed',
        candidate,
        error: { name: error.name, message: error.message },
      });
      continue;
    }
    const requiredModelPaths = [...new Set(selectedPaths)]
      .filter(path => path.endsWith('.onnx') || /\.onnx_data(?:_\d+)?$/u.test(path))
      .sort((left, right) => left.localeCompare(right));
    if (requiredModelPaths.length === 0) {
      throw new Error(`The resource selector returned no model artifacts for Production candidate ${candidateKey({ candidate })}`);
    }

    const missingPaths = new Set<string>();
    for (const repositoryPath of [...requiredModelPaths, ...requiredRuntimePaths]) {
      const existing = pathCompleteness.get(repositoryPath);
      if (existing === false) {
        missingPaths.add(repositoryPath);
        continue;
      }
      if (existing === true) continue;

      const response = await modelCache.match(downloadedModelResourceUrl({
        modelId,
        revision,
        repositoryPath,
        workerLocationUrl,
      }));
      const complete = response !== undefined;
      pathCompleteness.set(repositoryPath, complete);
      if (response !== undefined) await response.body?.cancel();
      if (!complete) missingPaths.add(repositoryPath);
    }
    const missingModelPaths = requiredModelPaths.filter(path => missingPaths.has(path));
    const missingRuntimePaths = requiredRuntimePaths.filter(path => missingPaths.has(path));
    entries.push({
      status: 'checked',
      candidate,
      requiredModelPaths,
      missingModelPaths,
      requiredRuntimePaths,
      missingRuntimePaths,
      complete: missingModelPaths.length === 0 && missingRuntimePaths.length === 0,
    });
  }
  return entries;
}

export function downloadedModelCandidatePlanError({
  modelId,
  revision,
  entries,
}: {
  modelId: string;
  revision: string | undefined;
  entries: readonly DownloadedModelCandidatePlanEntry[];
}): Error {
  const details = entries.map(entry => {
    const key = candidateKey({ candidate: entry.candidate });
    switch (entry.status) {
    case 'planning-failed':
      return `${key}: ${entry.error.message}`;
    case 'checked':
      return `${key}: ${[...entry.missingModelPaths, ...entry.missingRuntimePaths].join(', ') || 'no missing paths'}`;
    default: {
      const _ex: never = entry;
      throw new Error(`Unhandled candidate plan entry: ${String(_ex)}`);
    }
    }
  }).join('; ');
  if (!entries.some(entry => entry.status === 'checked')) {
    // Planning never established any required-file set. Calling this a cache
    // miss would authorize the explicit Download coordinator to fetch again.
    return new DownloadedModelResourcePlanningError({ modelId, revision, details });
  }
  return new MissingDownloadedModelArtifactError({ message:
    `Downloaded model is incomplete; loadDownloadedModel() MUST NOT fetch model artifacts, `
    + `and offline Load will not download or repair files `
    + `(model=${modelId}, revision=${revision ?? 'main'}): ${details}`,
  });
}

export const MISSING_DOWNLOADED_MODEL_ARTIFACT_ERROR_NAME = 'MissingDownloadedModelArtifact';

export class MissingDownloadedModelArtifactError extends Error {
  override readonly name = MISSING_DOWNLOADED_MODEL_ARTIFACT_ERROR_NAME;
  constructor({ message }: { message: string }) {
    super(message);
  }
}

export class DownloadedModelResourcePlanningError extends Error {
  override readonly name = 'DownloadedModelResourcePlanningError';
  constructor({ modelId, revision, details }: { modelId: string; revision: string | undefined; details: string }) {
    super(`No Production candidate could be planned (model=${modelId}, revision=${revision ?? 'main'}): ${details}`);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  modelFileUrl: downloadedModelResourceUrl,
};
