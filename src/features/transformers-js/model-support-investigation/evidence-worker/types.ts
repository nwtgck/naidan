import type { InvestigationReplayMetadataSidecar } from '@/features/transformers-js/model-support-investigation/logic/collect-replay-metadata';
import type { ProductionProviderNativeEvidenceSidecar } from '@/features/transformers-js/model-support-investigation/logic/production-provider-native-evidence';
import type {
  ModelSupportInvestigationBatchEvidenceItem,
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
  createPartialEvidence({ request, replayMetadata, nativeEvidence }: {
    request: Blob,
    replayMetadata?: InvestigationReplayMetadataSidecar[],
    nativeEvidence?: ProductionProviderNativeEvidenceSidecar,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  createBatchEvidence({ request, replayMetadata, nativeEvidence }: {
    request: Blob,
    replayMetadata?: Array<InvestigationReplayMetadataSidecar[] | undefined>,
    nativeEvidence?: Array<ProductionProviderNativeEvidenceSidecar | undefined>,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  createDownloadVerificationEvidence({ request }: {
    request: Blob,
  }): Promise<DownloadVerificationEvidenceArchive>,
}

export interface ModelSupportInvestigationEvidenceWorkerClient {
  createPartialEvidence({ run, recovery, replayMetadata, nativeEvidence }: {
    run: ModelSupportInvestigationRun,
    recovery: ModelSupportInvestigationRecovery | undefined,
    replayMetadata?: InvestigationReplayMetadataSidecar[],
    nativeEvidence?: ProductionProviderNativeEvidenceSidecar,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  createBatchEvidence({ batchId, items }: {
    batchId: string,
    items: readonly ModelSupportInvestigationBatchEvidenceItem[],
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
