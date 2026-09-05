import type {
  ModelSupportInvestigationRecovery,
  ModelSupportInvestigationRun,
} from "@/features/transformers-js/model-support-investigation/types";
import type {
  DownloadVerificationEvidenceArchive,
  DownloadVerificationEvidenceInput,
} from "@/features/transformers-js/download-verification/evidence/types";

export interface ModelSupportInvestigationEvidenceArchive {
  blob: Blob,
  fileName: string,
}

export interface IModelSupportInvestigationEvidenceWorker {
  createPartialEvidence({ request }: {
    request: Blob,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  createDownloadVerificationEvidence({ request }: {
    request: Blob,
  }): Promise<DownloadVerificationEvidenceArchive>,
}

export interface ModelSupportInvestigationEvidenceWorkerClient {
  createPartialEvidence({ run, recovery }: {
    run: ModelSupportInvestigationRun,
    recovery: ModelSupportInvestigationRecovery | undefined,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  createDownloadVerificationEvidence({ evidence }: {
    evidence: DownloadVerificationEvidenceInput,
  }): Promise<DownloadVerificationEvidenceArchive>,
  dispose(): Promise<void>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
