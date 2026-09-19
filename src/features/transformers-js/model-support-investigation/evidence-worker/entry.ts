import { exposeWorkerRemote } from "@/utils/worker-transport";
import { createModelSupportInvestigationEvidenceWorker } from "@/features/transformers-js/model-support-investigation/evidence-worker/impl";
import type { IModelSupportInvestigationEvidenceWorker } from "@/features/transformers-js/model-support-investigation/evidence-worker/types";

exposeWorkerRemote<IModelSupportInvestigationEvidenceWorker>({
  api: createModelSupportInvestigationEvidenceWorker(),
  endpoint: undefined,
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
