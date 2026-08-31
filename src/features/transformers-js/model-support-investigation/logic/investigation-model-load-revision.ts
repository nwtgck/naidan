import type { ModelSupportInvestigationRepository } from "@/features/transformers-js/model-support-investigation/types";

/**
 * Resolve the revision passed to Transformers.js model/tokenizer loaders during
 * Model Support Investigation. The measured path must match normal Chat rather
 * than freeze the repository SHA into a second OPFS cache namespace.
 */
export function investigationModelLoadRevision({
  requestedRevision,
}: {
  requestedRevision: ModelSupportInvestigationRepository["requestedRevision"],
}): string | undefined {
  switch (requestedRevision) {
  case "main":
    return undefined;
  default: {
    const _ex: never = requestedRevision;
    return _ex;
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
