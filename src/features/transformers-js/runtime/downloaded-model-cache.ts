import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import { createOpfsModelCache, type OpfsModelCacheMatchObservation } from '@/features/transformers-js/runtime/opfs-model-cache';

// Transformers.js 4.2 ModelRegistry probes these files without forwarding the
// caller's revision option. During an immutable-revision cache-only load, those
// probes therefore ask for `main` even though the downloaded artifacts live
// under the resolved commit SHA. Alias only the presence-probe files; the
// actual tokenizer/processor/model files continue to use the requested exact
// revision and remain fail-closed on cache misses.
const REVISION_INSENSITIVE_RUNTIME_METADATA_PATHS = [
  'tokenizer_config.json',
  'preprocessor_config.json',
] as const;

export function createDownloadedModelReadOnlyCache({
  modelId,
  revision,
  onMatchObservation,
}: {
  modelId: string,
  revision: string | undefined,
  onMatchObservation?: ({ observation }: { observation: OpfsModelCacheMatchObservation }) => void,
}): ReturnType<typeof createOpfsModelCache> {
  const normalizedModelId = normalizeTransformersJsProductionModelId({ modelId });
  const revisionAliases = revision === undefined || revision === 'main'
    ? []
    : [{
      modelId: normalizedModelId,
      resolvedRevision: 'main',
      sourceRevision: revision,
      repositoryPaths: [...REVISION_INSENSITIVE_RUNTIME_METADATA_PATHS],
    }];

  return createOpfsModelCache({
    mutationPolicy: 'read-only',
    revisionAliases,
    ...(onMatchObservation === undefined ? {} : { onMatchObservation }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
