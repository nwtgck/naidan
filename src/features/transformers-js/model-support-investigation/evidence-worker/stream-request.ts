import type { EvidenceStreamInput, EvidenceStreamRequest } from './types';
import { createModelSupportInvestigationEvidenceWorkerRequest } from './request';
import { createModelSupportInvestigationBatchEvidenceWorkerRequest } from './batch-request';
import { createDownloadVerificationEvidenceWorkerRequest } from './download-verification-request';
import { createOrdinaryDownloadTimingEvidenceFile } from '@/features/transformers-js/model-support-investigation/logic/ordinary-download-timing-evidence';

export function createEvidenceStreamRequest({ input }: { input: EvidenceStreamInput }): EvidenceStreamRequest {
  switch (input.kind) {
  case 'partial': {
    const { kind, run, recovery, replayMetadata, nativeEvidence, ordinaryDownloadTiming, ...unhandled } = input;
    unhandled satisfies Record<PropertyKey, never>;
    return {
      kind,
      request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }),
      replayMetadata,
      nativeEvidence,
      ordinaryDownloadTiming: ordinaryDownloadTiming === undefined ? undefined : createOrdinaryDownloadTimingEvidenceFile({ snapshot: ordinaryDownloadTiming, association: { kind: 'investigation-run', runId: run.runId } }),
    };
  }
  case 'batch': {
    const { kind, batchId, items, ordinaryDownloadTiming, ...unhandled } = input;
    unhandled satisfies Record<PropertyKey, never>;
    return {
      kind,
      request: createModelSupportInvestigationBatchEvidenceWorkerRequest({ batchId, items }),
      replayMetadata: items.map(item => item.replayMetadata),
      nativeEvidence: items.map(item => item.nativeEvidence),
      ordinaryDownloadTiming: ordinaryDownloadTiming === undefined ? undefined : createOrdinaryDownloadTimingEvidenceFile({ snapshot: ordinaryDownloadTiming, association: { kind: 'investigation-batch', batchId } }),
    };
  }
  case 'download-verification': {
    const { kind, evidence, ...unhandled } = input;
    unhandled satisfies Record<PropertyKey, never>;
    return { kind, request: createDownloadVerificationEvidenceWorkerRequest({ evidence }) };
  }
  case 'retained-timing': {
    const { kind, snapshot, exportId, ...unhandled } = input;
    unhandled satisfies Record<PropertyKey, never>;
    return { kind, request: createOrdinaryDownloadTimingEvidenceFile({ snapshot, association: { kind: 'retained-export', exportId, investigation: 'not-run' } }) };
  }
  default: {
    const exhaustive: never = input;
    throw new Error(`Unsupported Evidence stream input: ${String(exhaustive)}`);
  }
  }
}

export const TEST_ONLY = {
};
