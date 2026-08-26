import type {
  ModelSupportInvestigationCacheInventory,
  ModelSupportInvestigationCandidateFilePlan,
  ModelSupportInvestigationCandidateRequiredFileCoverage,
} from "@/features/transformers-js/model-support-investigation/types";

export function evaluateCandidateRequiredFileCoverage({
  candidate,
  inventory,
}: {
  candidate: ModelSupportInvestigationCandidateFilePlan,
  inventory: ModelSupportInvestigationCacheInventory,
}): ModelSupportInvestigationCandidateRequiredFileCoverage {
  const expectedPaths = candidate.files
    .filter(file => file.requirement === "required")
    .map(file => file.path)
    .sort((a, b) => a.localeCompare(b));
  const completePaths: string[] = [];
  const incompletePaths: string[] = [];
  const missingPaths: string[] = [];
  for (const path of expectedPaths) {
    const matches = inventory.files.filter(file => file.repositoryPath === path);
    if (matches.some(file => file.size > 0 && file.hasCompletionMarker)) {
      completePaths.push(path);
    } else if (matches.length > 0) {
      incompletePaths.push(path);
    } else {
      missingPaths.push(path);
    }
  }
  return {
    expectedPaths,
    completePaths,
    incompletePaths,
    missingPaths,
    revisionProvenance: "unknown",
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
