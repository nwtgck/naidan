import type { WorkerServerApi } from '@/utils/worker-transport';
import {
  prepareBatchModelSupportEvidence,
  preparePartialModelSupportEvidence,
} from "@/features/transformers-js/model-support-investigation/logic/create-partial-evidence";
import type { EvidenceStreamRequest, IModelSupportInvestigationEvidenceWorker } from "@/features/transformers-js/model-support-investigation/evidence-worker/types";
import { readModelSupportInvestigationEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/request";
import { readModelSupportInvestigationBatchEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/batch-request";
import { readDownloadVerificationEvidenceWorkerRequest } from "@/features/transformers-js/model-support-investigation/evidence-worker/download-verification-request";
import { prepareDownloadVerificationEvidence } from "@/features/transformers-js/download-verification/evidence/create-download-verification-evidence";
import { replayMetadataSidecarsSchema } from '@/features/transformers-js/model-support-investigation/logic/replay-metadata-export';
import { prepareRetainedDownloadTimingEvidence, readOrdinaryDownloadTimingEvidenceFile } from '@/features/transformers-js/model-support-investigation/logic/ordinary-download-timing-evidence';

import { serveByteStream, byteStreamPortSchema } from '@/utils/byte-stream-port';
import { createEvidenceArchiveStream, type PreparedEvidenceArchive } from '@/features/transformers-js/model-support-investigation/logic/evidence-archive';

async function prepare({ input }: { input: EvidenceStreamRequest }): Promise<PreparedEvidenceArchive> {
  switch (input.kind) {
  case 'partial': {
    const { request, replayMetadata, nativeEvidence, ordinaryDownloadTiming } = input;
    const { run, recovery } = await readModelSupportInvestigationEvidenceWorkerRequest({ request });
    const sidecars = replayMetadata === undefined ? undefined : replayMetadataSidecarsSchema.parse(replayMetadata);
    const timing = ordinaryDownloadTiming === undefined ? undefined : await readOrdinaryDownloadTimingEvidenceFile({ file: ordinaryDownloadTiming });
    if (timing !== undefined && (timing.association.kind !== 'investigation-run' || timing.association.runId !== run.runId)) throw new Error('Retained Download timing run association mismatch');
    return await preparePartialModelSupportEvidence({ run, recovery, replayMetadata: sidecars, nativeEvidence, ordinaryDownloadTiming: timing?.snapshot });

  }
  case 'batch': {
    const { request, replayMetadata, nativeEvidence, ordinaryDownloadTiming } = input;
    const { batchId, items } = await readModelSupportInvestigationBatchEvidenceWorkerRequest({ request });
    if (replayMetadata !== undefined && replayMetadata.length !== items.length) throw new Error('Replay sidecar target count mismatch');
    if (nativeEvidence !== undefined && (!Array.isArray(nativeEvidence) || nativeEvidence.length !== items.length)) throw new Error('Native sidecar target count mismatch');
    const timing = ordinaryDownloadTiming === undefined ? undefined : await readOrdinaryDownloadTimingEvidenceFile({ file: ordinaryDownloadTiming });
    if (timing !== undefined && (timing.association.kind !== 'investigation-batch' || timing.association.batchId !== batchId)) throw new Error('Retained Download timing batch association mismatch');
    return await prepareBatchModelSupportEvidence({
      batchId,
      ordinaryDownloadTiming: timing?.snapshot,
      items: items.map((item, index) => ({
        ...item,
        replayMetadata: replayMetadata?.[index] === undefined ? undefined : replayMetadataSidecarsSchema.parse(replayMetadata[index]),
        nativeEvidence: nativeEvidence?.[index],
      })),
    });

  }
  case 'download-verification': {
    const { request } = input;
    const { evidence } = await readDownloadVerificationEvidenceWorkerRequest({ request });
    return await prepareDownloadVerificationEvidence({ evidence });

  }
  case 'retained-timing': {
    const { request } = input;
    const document = await readOrdinaryDownloadTimingEvidenceFile({ file: request });
    switch (document.association.kind) {
    case 'retained-export':
      return await prepareRetainedDownloadTimingEvidence({ snapshot: document.snapshot, exportId: document.association.exportId });
    case 'investigation-run':
    case 'investigation-batch':
      throw new Error('Expected a retained-only Download timing export');
    default: {
      const exhaustive: never = document.association;
      return exhaustive;
    }
    }

  }
  default: {
    const exhaustive: never = input;
    throw new Error(`Unsupported Evidence stream request: ${String(exhaustive)}`);
  }
  }
}

export const streamEvidence: WorkerServerApi<IModelSupportInvestigationEvidenceWorker>['streamEvidence'] = async ({ input, port }) => {
  const dataPort = byteStreamPortSchema.parse(port);
  try {
    const { files, fileName } = await prepare({ input });
    // Start encoding only on the first pull. Preparation verifies immutable files
    // and manifests; it does not materialize/re-read the complete encoded ZIP.
    serveByteStream({ port: dataPort, openStream: async () => createEvidenceArchiveStream({ files }), signal: undefined });
    return { fileName };
  } catch (error) {
    dataPort.close();
    throw error;
  }
};

export const TEST_ONLY = {
};
