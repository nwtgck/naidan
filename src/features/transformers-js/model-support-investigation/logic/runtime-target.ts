import type {
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationLocalCacheRevisionSelection,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationRuntimeTarget,
} from "@/features/transformers-js/model-support-investigation/types";

const IMMUTABLE_HUGGING_FACE_REVISION_PATTERN = /^[0-9a-f]{40}$/iu;

function completedConfigRevisions({ cache }: {
  cache: ModelSupportInvestigationCacheInventory,
}): string[] {
  return [...new Set(cache.files
    .filter(file => (
      file.repositoryPath === "config.json"
      && file.size > 0
      && file.hasCompletionMarker
      && file.cacheRevision !== undefined
    ))
    .map(file => file.cacheRevision as string))]
    .sort((a, b) => a.localeCompare(b));
}

export function selectLocalCacheRevision({ cache }: {
  cache: ModelSupportInvestigationCacheInventory,
}): ModelSupportInvestigationLocalCacheRevisionSelection {
  if (!cache.exists) {
    return { status: "unavailable", reason: "The local model cache directory does not exist" };
  }

  const revisions = completedConfigRevisions({ cache });
  const immutableRevisions = revisions.filter(revision => IMMUTABLE_HUGGING_FACE_REVISION_PATTERN.test(revision));
  if (immutableRevisions.length === 1) {
    return {
      status: "selected",
      revision: immutableRevisions[0]!,
      revisionIdentity: "local-immutable-revision",
      loaderRevisionOption: immutableRevisions[0]!,
    };
  }
  if (immutableRevisions.length > 1) {
    return {
      status: "ambiguous",
      revisions: immutableRevisions,
      reason: "Multiple immutable local revisions contain completed config.json; investigation will not guess which revision represents the downloaded model",
    };
  }
  if (revisions.includes("main")) {
    return {
      status: "selected",
      revision: "main",
      revisionIdentity: "legacy-main-unverified",
      loaderRevisionOption: null,
    };
  }
  if (revisions.length > 0) {
    return {
      status: "ambiguous",
      revisions,
      reason: "Completed config.json exists only under mutable or unrecognized local revisions; investigation will not infer revision identity",
    };
  }
  return {
    status: "unavailable",
    reason: "No non-zero completed config.json is available in the local model cache",
  };
}

export function runtimeTargetFromRepository({ repository }: {
  repository: ModelSupportInvestigationRepository,
}): ModelSupportInvestigationRuntimeTarget {
  return {
    normalizedModelId: repository.normalizedModelId,
    evidenceRevision: repository.resolvedRevision,
    loaderRevisionOption: null,
    source: "repository",
    revisionIdentity: "exact-resolved-revision",
    pipelineTag: repository.pipelineTag,
  };
}

export function runtimeTargetFromLocalCache({
  cache,
}: {
  cache: ModelSupportInvestigationCacheInventory,
}): ModelSupportInvestigationRuntimeTarget | undefined {
  const selection = selectLocalCacheRevision({ cache });
  switch (selection.status) {
  case "selected":
    return {
      normalizedModelId: cache.normalizedModelId,
      evidenceRevision: selection.revision,
      loaderRevisionOption: selection.loaderRevisionOption,
      source: "local-cache",
      revisionIdentity: selection.revisionIdentity,
      pipelineTag: undefined,
    };
  case "unavailable":
  case "ambiguous":
    return undefined;
  default: {
    const _ex: never = selection;
    return _ex;
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  completedConfigRevisions,
};
