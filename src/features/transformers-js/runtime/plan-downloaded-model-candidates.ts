import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';

interface ReadOnlyModelCache {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the Cache API consumed by Transformers.js.
  match(request: string | Request): Promise<Response | undefined>;
}

export interface DownloadedModelCandidatePlanEntry {
  candidate: TransformersJsProductionInvestigationCandidate;
  requiredModelPaths: string[];
  missingModelPaths: string[];
  requiredRuntimePaths: string[];
  missingRuntimePaths: string[];
  complete: boolean;
}

function candidateKey({ candidate }: {
  candidate: TransformersJsProductionInvestigationCandidate;
}): string {
  return `${candidate.device}/${candidate.dtype}`;
}

function modelFileUrl({
  modelId,
  revision,
  repositoryPath,
  workerLocationUrl,
}: {
  modelId: string;
  revision: string | undefined;
  repositoryPath: string;
  workerLocationUrl: string;
}): string {
  const encodedPath = repositoryPath.split('/').map(part => encodeURIComponent(part)).join('/');
  if (modelId.startsWith('user/') || modelId.startsWith('local/')) {
    const encodedModelId = modelId.split('/').map(part => encodeURIComponent(part)).join('/');
    return new URL(`/${encodedModelId}/${encodedPath}`, workerLocationUrl).href;
  }
  const encodedModelId = modelId.split('/').map(part => encodeURIComponent(part)).join('/');
  return `https://huggingface.co/${encodedModelId}/resolve/${encodeURIComponent(revision ?? 'main')}/${encodedPath}`;
}

/**
 * Derives candidate completeness from the runtime's own ModelRegistry plan and
 * the existing OPFS files/`.complete` markers.
 *
 * This is intentionally recomputed instead of persisted as a Naidan-specific
 * manifest: ModelRegistry is the versioned source of truth for the active
 * Transformers.js runtime, while cache.match performs only OPFS metadata/file
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
    const requiredModelPaths = [...new Set(await getModelFiles({ candidate }))]
      .filter(path => path.endsWith('.onnx') || /\.onnx_data(?:_\d+)?$/u.test(path))
      .sort((left, right) => left.localeCompare(right));
    if (requiredModelPaths.length === 0) {
      throw new Error(`ModelRegistry returned no model artifacts for Production candidate ${candidateKey({ candidate })}`);
    }

    const missingPaths = new Set<string>();
    for (const repositoryPath of [...requiredModelPaths, ...requiredRuntimePaths]) {
      const existing = pathCompleteness.get(repositoryPath);
      if (existing === false) {
        missingPaths.add(repositoryPath);
        continue;
      }
      if (existing === true) continue;

      const response = await modelCache.match(modelFileUrl({
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
  const details = entries.map(entry => (
    `${candidateKey({ candidate: entry.candidate })}: ${[
      ...entry.missingModelPaths,
      ...entry.missingRuntimePaths,
    ].join(', ') || 'no missing paths'}`
  )).join('; ');
  return new Error(
    `Downloaded model is incomplete; loadDownloadedModel() MUST NOT fetch model artifacts, `
    + `and offline Load will not download or repair files `
    + `(model=${modelId}, revision=${revision ?? 'main'}): ${details}`,
  );
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  modelFileUrl,
};
