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
  const sizeMismatchPaths: string[] = [];
  const incompletePaths: string[] = [];
  const missingPaths: string[] = [];
  for (const path of expectedPaths) {
    const planned = candidate.files.find(file => file.path === path);
    const repositorySize = planned?.repositorySize;
    const matches = inventory.files.filter(file => file.repositoryPath === path);
    const completeMatch = matches.some(file => (
      file.size > 0
      && file.hasCompletionMarker
      && (repositorySize === undefined || file.size === repositorySize)
    ));
    if (completeMatch) {
      completePaths.push(path);
    } else if (matches.some(file => (
      file.size > 0
      && file.hasCompletionMarker
      && repositorySize !== undefined
      && file.size !== repositorySize
    ))) {
      sizeMismatchPaths.push(path);
    } else if (matches.length > 0) {
      incompletePaths.push(path);
    } else {
      missingPaths.push(path);
    }
  }
  return {
    expectedPaths,
    completePaths,
    sizeMismatchPaths,
    incompletePaths,
    missingPaths,
    revisionProvenance: "unknown",
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
