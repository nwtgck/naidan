import type {
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";

export interface ModelSupportInvestigationEvidenceArchive {
  blob: Blob,
  fileName: string,
}

export interface IModelSupportInvestigationEvidenceWorker {
  createPartialEvidence({ request }: {
    request: Blob,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
}

export interface ModelSupportInvestigationEvidenceWorkerClient {
  createPartialEvidence({ run, recovery }: {
    run: ModelSupportInvestigationRun,
    recovery: ModelSupportInvestigationRecovery | undefined,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  dispose(): Promise<void>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
