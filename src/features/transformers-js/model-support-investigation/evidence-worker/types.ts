import type { WorkerTransfer } from '@/utils/worker-transport';
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

export type EvidenceStreamRequest =
  | ({ kind: 'partial' } & Parameters<IModelSupportInvestigationEvidenceWorker['createPartialEvidence']>[0])
  | ({ kind: 'batch' } & Parameters<IModelSupportInvestigationEvidenceWorker['createBatchEvidence']>[0])
  | ({ kind: 'download-verification' } & Parameters<IModelSupportInvestigationEvidenceWorker['createDownloadVerificationEvidence']>[0])
  | ({ kind: 'retained-timing' } & Parameters<IModelSupportInvestigationEvidenceWorker['createRetainedDownloadTimingEvidence']>[0]);

export type EvidenceStreamInput =
  | ({ kind: 'partial' } & Parameters<ModelSupportInvestigationEvidenceWorkerClient['createPartialEvidence']>[0])
  | ({ kind: 'batch' } & Parameters<ModelSupportInvestigationEvidenceWorkerClient['createBatchEvidence']>[0])
  | ({ kind: 'download-verification' } & Parameters<ModelSupportInvestigationEvidenceWorkerClient['createDownloadVerificationEvidence']>[0])
  | ({ kind: 'retained-timing' } & Parameters<ModelSupportInvestigationEvidenceWorkerClient['createRetainedDownloadTimingEvidence']>[0]);

export interface IModelSupportInvestigationEvidenceWorker {
  streamEvidence({ input, port }: WorkerTransfer<{ input: EvidenceStreamRequest; port: MessagePort }>): Promise<{ fileName: string }> ,
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
  openEvidenceStream({ input }: { input: EvidenceStreamInput }): Promise<{ stream: ReadableStream<Uint8Array>; fileName: string }> ,
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
