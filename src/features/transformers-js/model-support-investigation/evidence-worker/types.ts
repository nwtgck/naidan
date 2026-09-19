import type { InvestigationReplayMetadataSidecar } from '@/features/transformers-js/model-support-investigation/logic/collect-replay-metadata';
import type { ProductionProviderNativeEvidenceSidecar } from '@/features/transformers-js/model-support-investigation/logic/production-provider-native-evidence';
import type { DownloadTimingSnapshot } from '@/features/transformers-js/download-timing';
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
  createPartialEvidence({ request, replayMetadata, nativeEvidence, ordinaryDownloadTiming }: {
    request: Blob,
    replayMetadata?: InvestigationReplayMetadataSidecar[],
    nativeEvidence?: ProductionProviderNativeEvidenceSidecar,
    ordinaryDownloadTiming?: Blob,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  createBatchEvidence({ request, replayMetadata, nativeEvidence, ordinaryDownloadTiming }: {
    request: Blob,
    replayMetadata?: Array<InvestigationReplayMetadataSidecar[] | undefined>,
    nativeEvidence?: Array<ProductionProviderNativeEvidenceSidecar | undefined>,
    ordinaryDownloadTiming?: Blob,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  createDownloadVerificationEvidence({ request }: {
    request: Blob,
  }): Promise<DownloadVerificationEvidenceArchive>,
  createRetainedDownloadTimingEvidence({ request }: { request: Blob }): Promise<ModelSupportInvestigationEvidenceArchive>,
}

export interface ModelSupportInvestigationEvidenceWorkerClient {
  createPartialEvidence({ run, recovery, replayMetadata, nativeEvidence, ordinaryDownloadTiming }: {
    run: ModelSupportInvestigationRun,
    recovery: ModelSupportInvestigationRecovery | undefined,
    replayMetadata?: InvestigationReplayMetadataSidecar[],
    nativeEvidence?: ProductionProviderNativeEvidenceSidecar,
    ordinaryDownloadTiming?: DownloadTimingSnapshot,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  createBatchEvidence({ batchId, items, ordinaryDownloadTiming }: {
    batchId: string,
    items: readonly ModelSupportInvestigationBatchEvidenceItem[],
    ordinaryDownloadTiming?: DownloadTimingSnapshot,
  }): Promise<ModelSupportInvestigationEvidenceArchive>,
  createDownloadVerificationEvidence({ evidence }: {
    evidence: DownloadVerificationEvidenceInput,
  }): Promise<DownloadVerificationEvidenceArchive>,
  createRetainedDownloadTimingEvidence({ snapshot, exportId }: { snapshot: DownloadTimingSnapshot; exportId: string }): Promise<ModelSupportInvestigationEvidenceArchive>,
  dispose(): Promise<void>,
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
