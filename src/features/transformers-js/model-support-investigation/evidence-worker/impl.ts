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

export function createModelSupportInvestigationEvidenceWorker(): IModelSupportInvestigationEvidenceWorker {
  return {
    async createPartialEvidence({ request, replayMetadata }) {
      const { run, recovery } = await readModelSupportInvestigationEvidenceWorkerRequest({ request });
      const sidecars = replayMetadata === undefined ? undefined : replayMetadataSidecarsSchema.parse(replayMetadata);
      return await createPartialModelSupportEvidence({ run, recovery, replayMetadata: sidecars });
    },
    async createBatchEvidence({ request, replayMetadata }) {
      const { batchId, items } = await readModelSupportInvestigationBatchEvidenceWorkerRequest({ request });
      if (replayMetadata !== undefined && replayMetadata.length !== items.length) throw new Error('Replay sidecar target count mismatch');
      return await createBatchModelSupportEvidence({ batchId, items: items.map((item, index) => ({
        ...item,
        replayMetadata: replayMetadata?.[index] === undefined ? undefined : replayMetadataSidecarsSchema.parse(replayMetadata[index]),
      })) });
    },
    async createDownloadVerificationEvidence({ request }) {
      const { evidence } = await readDownloadVerificationEvidenceWorkerRequest({ request });
      return await createDownloadVerificationEvidence({ evidence });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
