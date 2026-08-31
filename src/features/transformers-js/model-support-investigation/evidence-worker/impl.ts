import { createPartialModelSupportEvidence } from "@/features/transformers-js/model-support-investigation/logic/create-partial-evidence";
import type { IModelSupportInvestigationEvidenceWorker } from "@/features/transformers-js/model-support-investigation/evidence-worker/types";
import { readModelSupportInvestigationEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/request";

export function createModelSupportInvestigationEvidenceWorker(): IModelSupportInvestigationEvidenceWorker {
  return {
    async createPartialEvidence({ request }) {
      const { run, recovery } = await readModelSupportInvestigationEvidenceWorkerRequest({ request });
      return await createPartialModelSupportEvidence({ run, recovery });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
