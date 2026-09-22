import {
  createBatchModelSupportEvidence,
  createPartialModelSupportEvidence,
} from "@/features/transformers-js/model-support-investigation/logic/create-partial-evidence";
import type { IModelSupportInvestigationEvidenceWorker } from "@/features/transformers-js/model-support-investigation/evidence-worker/types";
import { readModelSupportInvestigationEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/request";
import { readModelSupportInvestigationBatchEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/batch-request";
import { readDownloadVerificationEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/download-verification-request";
import { createDownloadVerificationEvidence } from "@/features/transformers-js/download-verification/evidence/create-download-verification-evidence";
import { replayMetadataSidecarsSchema } from '@/features/transformers-js/model-support-investigation/logic/replay-metadata-export';
import { createRetainedDownloadTimingEvidence, readOrdinaryDownloadTimingEvidenceFile } from '@/features/transformers-js/model-support-investigation/logic/ordinary-download-timing-evidence';

export function createModelSupportInvestigationEvidenceWorker(): IModelSupportInvestigationEvidenceWorker {
  return {
    async createPartialEvidence({ request, replayMetadata, nativeEvidence, ordinaryDownloadTiming }) {
      const { run, recovery } = await readModelSupportInvestigationEvidenceWorkerRequest({ request });
      const sidecars = replayMetadata === undefined ? undefined : replayMetadataSidecarsSchema.parse(replayMetadata);
      const timing = ordinaryDownloadTiming === undefined ? undefined : await readOrdinaryDownloadTimingEvidenceFile({ file: ordinaryDownloadTiming });
      if (timing !== undefined && (timing.association.kind !== 'investigation-run' || timing.association.runId !== run.runId)) throw new Error('Retained Download timing run association mismatch');
      return await createPartialModelSupportEvidence({ run, recovery, replayMetadata: sidecars, nativeEvidence, ordinaryDownloadTiming: timing?.snapshot });
    },
    async createBatchEvidence({ request, replayMetadata, nativeEvidence, ordinaryDownloadTiming }) {
      const { batchId, items } = await readModelSupportInvestigationBatchEvidenceWorkerRequest({ request });
      if (replayMetadata !== undefined && replayMetadata.length !== items.length) throw new Error('Replay sidecar target count mismatch');
      if (nativeEvidence !== undefined && (!Array.isArray(nativeEvidence) || nativeEvidence.length !== items.length)) throw new Error('Native sidecar target count mismatch');
      const timing = ordinaryDownloadTiming === undefined ? undefined : await readOrdinaryDownloadTimingEvidenceFile({ file: ordinaryDownloadTiming });
      if (timing !== undefined && (timing.association.kind !== 'investigation-batch' || timing.association.batchId !== batchId)) throw new Error('Retained Download timing batch association mismatch');
      return await createBatchModelSupportEvidence({ batchId, ordinaryDownloadTiming: timing?.snapshot, items: items.map((item, index) => ({
        ...item,
        replayMetadata: replayMetadata?.[index] === undefined ? undefined : replayMetadataSidecarsSchema.parse(replayMetadata[index]),
        nativeEvidence: nativeEvidence?.[index],
      })) });
    },
    async createDownloadVerificationEvidence({ request }) {
      const { evidence } = await readDownloadVerificationEvidenceWorkerRequest({ request });
      return await createDownloadVerificationEvidence({ evidence });
    },
    async createRetainedDownloadTimingEvidence({ request }) {
      const document = await readOrdinaryDownloadTimingEvidenceFile({ file: request });
      switch (document.association.kind) {
      case 'retained-export':
        return await createRetainedDownloadTimingEvidence({ snapshot: document.snapshot, exportId: document.association.exportId });
      case 'investigation-run':
      case 'investigation-batch':
        throw new Error('Expected a retained-only Download timing export');
      default: {
        const exhaustive: never = document.association;
        return exhaustive;
      }
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
