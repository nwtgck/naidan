import { describe, expect, it } from 'vitest';
import type { DownloadVerificationEvidenceInput } from '@/features/transformers-js/download-verification/evidence/types';
import {
  createDownloadVerificationEvidenceWorkerRequest,
  readDownloadVerificationEvidenceWorkerRequest,
} from '@/features/transformers-js/model-support-investigation/evidence-worker/download-verification-request';

describe('Download Verification Evidence Worker request', () => {
  it('serializes probe evidence into a clone-safe Blob', async () => {
    const evidence = {
      schemaVersion: 1,
      runId: 'download-run-1',
      mode: 'probe-only',
      run: { normalizedModelId: 'org/model' },
      modelArtifactObservations: [],
      modelArtifactObservationError: undefined,
      cacheBefore: undefined,
      cacheInspectionError: undefined,
    } as unknown as DownloadVerificationEvidenceInput;
    const request = createDownloadVerificationEvidenceWorkerRequest({ evidence });
    expect(request).toBeInstanceOf(Blob);
    await expect(readDownloadVerificationEvidenceWorkerRequest({ request })).resolves.toMatchObject({
      schemaVersion: 1,
      evidence: { runId: 'download-run-1', mode: 'probe-only' },
    });
  });
});
