import type { TransformersJsCacheRevisionAlias } from "@/features/transformers-js/types";
import type {
  ModelSupportInvestigationCacheProvenance,
  ModelSupportInvestigationRepository,
} from "@/features/transformers-js/model-support-investigation/types";

export function createCacheRevisionAliases({
  repository,
  provenance,
}: {
  repository: ModelSupportInvestigationRepository,
  provenance: ModelSupportInvestigationCacheProvenance | undefined,
}): TransformersJsCacheRevisionAlias[] {
  if (provenance === undefined) return [];

  const pathsByRevision = new Map<string, Set<string>>();
  for (const file of provenance.files) {
    switch (file.status) {
    case "mismatched":
    case "partial":
      continue;
    case "bounded-samples-matched":
      break;
    default: {
      const _ex: never = file.status;
      throw new Error(`Unhandled cache provenance status: ${_ex}`);
    }
    }
    if (file.cacheRevision === repository.resolvedRevision) continue;
    const paths = pathsByRevision.get(file.cacheRevision) ?? new Set<string>();
    paths.add(file.repositoryPath);
    pathsByRevision.set(file.cacheRevision, paths);
  }

  return [...pathsByRevision.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceRevision, repositoryPaths]) => ({
      modelId: repository.normalizedModelId,
      resolvedRevision: repository.resolvedRevision,
      sourceRevision,
      repositoryPaths: [...repositoryPaths].sort((left, right) => left.localeCompare(right)),
    }));
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
