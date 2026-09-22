// @vitest-environment node
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exposeWorkerRemote, releaseWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import type { IModelSupportInvestigationEvidenceWorker } from '@/features/transformers-js/model-support-investigation/evidence-worker/types';
import { downloadTimingSnapshotSchema } from '@/features/transformers-js/download-timing';
import { createModelSupportInvestigationEvidenceWorker } from '@/features/transformers-js/model-support-investigation/evidence-worker/impl';
import { createModelSupportInvestigationEvidenceWorkerRequest } from '@/features/transformers-js/model-support-investigation/evidence-worker/request';
import { createModelSupportInvestigationBatchEvidenceWorkerRequest } from '@/features/transformers-js/model-support-investigation/evidence-worker/batch-request';
import { createInitialInvestigationCheckpoint } from './investigation-recovery';
import { openEvidenceArchive } from './evidence-archive';
import { verifyGeneratedEvidenceArchive } from './verify-evidence-archive';
import { createOrdinaryDownloadTimingEvidenceFile, ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH, ORDINARY_DOWNLOAD_TIMING_MAXIMUM_BYTES, readOrdinaryDownloadTimingEvidenceFile } from './ordinary-download-timing-evidence';

// Synthetic lifecycle scalars, not browser performance measurements.
function snapshot() {
  return downloadTimingSnapshotSchema.parse({
    format: 'transformers-js-download-timing-v1', measurementVersion: 1, source: 'ordinary-download',
    serviceEpoch: '11111111-1111-4111-8111-111111111111', identityStatus: 'available', sequence: 1,
    availability: 'recorded', droppedOperations: 2,
    records: [{ operationId: '11111111-1111-4111-8111-111111111111/1', modelId: 'org/previous', runtimeEpoch: 3,
      outcome: 'failed', timingStatus: 'measured', wallMs: 23000, truncated: true,
      droppedObservations: 1, observations: [] }],
  });
}

describe('ordinary Download timing evidence', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
  });

  it('crosses actual Comlink without changing the original operation identity', async () => {
    const channel = new MessageChannel();
    exposeWorkerRemote<IModelSupportInvestigationEvidenceWorker>({ api: createModelSupportInvestigationEvidenceWorker(), endpoint: channel.port1 });
    const remote = wrapWorkerRemote<IModelSupportInvestigationEvidenceWorker>({ endpoint: channel.port2 });
    try {
      const result = await remote.createRetainedDownloadTimingEvidence({ request: createOrdinaryDownloadTimingEvidenceFile({ snapshot: snapshot(), association: { kind: 'retained-export', exportId: 'transport-export', investigation: 'not-run' } }) });
      const archive = await openEvidenceArchive({ blob: result.blob });
      try {
        const file = await archive.reader.read({ path: ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH, maximumBytes: ORDINARY_DOWNLOAD_TIMING_MAXIMUM_BYTES });
        const document = await readOrdinaryDownloadTimingEvidenceFile({ file: file! });
        expect(document.snapshot).toEqual(snapshot());
        expect(document.association).toEqual({ kind: 'retained-export', exportId: 'transport-export', investigation: 'not-run' });
      } finally {
        await archive.close();
      }
    } finally {
      await releaseWorkerRemote({ remote });
      channel.port1.close();
      channel.port2.close();
    }
  });

  it('exports only the immutable retained observation through the real Worker implementation and shared ZIP', async () => {
    const source = snapshot();
    const request = createOrdinaryDownloadTimingEvidenceFile({ snapshot: source, association: { kind: 'retained-export', exportId: 'export-1', investigation: 'not-run' } });
    source.records[0]!.outcome = 'completed';
    const result = await createModelSupportInvestigationEvidenceWorker().createRetainedDownloadTimingEvidence({ request });
    const archive = await openEvidenceArchive({ blob: result.blob });
    try {
      expect(archive.reader.paths).toEqual([ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH]);
      const file = await archive.reader.read({ path: ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH });
      const document = await readOrdinaryDownloadTimingEvidenceFile({ file: file! });
      expect(document.association).toEqual({ kind: 'retained-export', exportId: 'export-1', investigation: 'not-run' });
      expect(document.snapshot).toEqual(snapshot());
      expect(document.snapshot.records[0]?.outcome).toBe('failed');
      expect(archive.reader.paths).not.toContain('run.json');
      expect(archive.reader.paths).not.toContain('download-lane/cache-acceptance.json');
    } finally {
      await archive.close();
    }
  });

  it.each(['partial', 'final', 'batch'] as const)('preserves the previous operation independently of the current %s investigation', async mode => {
    const { run, recovery } = createInitialInvestigationCheckpoint({ modelId: 'org/current', runId: 'current-run', now: () => '2026-09-13T00:00:00.000Z' });
    if (mode === 'final') {
      run.status = 'failed'; run.completedAt = '2026-09-13T00:00:01.000Z';
    }
    const worker = createModelSupportInvestigationEvidenceWorker();
    const source = snapshot();
    const association = mode === 'batch' ? { kind: 'investigation-batch' as const, batchId: 'current-batch' } : { kind: 'investigation-run' as const, runId: run.runId };
    const ordinaryDownloadTiming = createOrdinaryDownloadTimingEvidenceFile({ snapshot: source, association });
    const result = mode === 'batch'
      ? await worker.createBatchEvidence({ request: createModelSupportInvestigationBatchEvidenceWorkerRequest({ batchId: 'current-batch', items: [{ target: run.modelId, status: 'failed', run, recovery, error: undefined }] }), ordinaryDownloadTiming })
      : await worker.createPartialEvidence({ request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }), ordinaryDownloadTiming });
    if (mode !== 'batch') await verifyGeneratedEvidenceArchive({ blob: result.blob });
    const archive = await openEvidenceArchive({ blob: result.blob });
    try {
      expect(archive.reader.paths.filter(path => path.endsWith('ordinary-download-timing.json'))).toEqual([ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH]);
      const file = await archive.reader.read({ path: ORDINARY_DOWNLOAD_TIMING_EVIDENCE_PATH });
      const document = await readOrdinaryDownloadTimingEvidenceFile({ file: file! });
      expect(document.association).toEqual(association);
      expect(document.snapshot).toEqual(source);
      expect(document.snapshot.records[0]?.modelId).toBe('org/previous');
      const runPath = archive.reader.paths.find(path => path.endsWith('run.json'))!;
      const packagedRun = JSON.parse(await (await archive.reader.read({ path: runPath }))!.text());
      expect(packagedRun.runId).toBe('current-run');
      expect(packagedRun.modelId).toBe('org/current');
      expect(packagedRun.status).toBe(run.status);
    } finally {
      await archive.close();
    }
  });

  it('refuses a foreign association before producing an investigation archive', async () => {
    const { run, recovery } = createInitialInvestigationCheckpoint({ modelId: 'org/current', runId: 'current-run', now: () => '2026-09-13T00:00:00.000Z' });
    await expect(createModelSupportInvestigationEvidenceWorker().createPartialEvidence({
      request: createModelSupportInvestigationEvidenceWorkerRequest({ run, recovery }),
      ordinaryDownloadTiming: createOrdinaryDownloadTimingEvidenceFile({ snapshot: snapshot(), association: { kind: 'investigation-run', runId: 'foreign' } }),
    })).rejects.toThrow('association mismatch');
  });

  it('refuses oversized input before JSON parsing and refuses malformed timing', async () => {
    const file = new Blob([' '.repeat(ORDINARY_DOWNLOAD_TIMING_MAXIMUM_BYTES + 1)]);
    const read = vi.spyOn(file, 'text');
    await expect(readOrdinaryDownloadTimingEvidenceFile({ file })).rejects.toThrow('byte budget');
    expect(read).not.toHaveBeenCalled();
    const invalid = snapshot();
    invalid.records[0]!.wallMs = -1;
    await expect(createModelSupportInvestigationEvidenceWorker().createRetainedDownloadTimingEvidence({ request: new Blob([JSON.stringify({ format: 'ordinary-download-timing-evidence-v1', association: { kind: 'retained-export', exportId: 'invalid', investigation: 'not-run' }, snapshot: invalid })]) })).rejects.toThrow();
  });

  it('does not invent an operation for an empty service session', async () => {
    const source = snapshot();
    source.records = [];
    source.availability = 'unavailable-in-this-service-session';
    await expect(createModelSupportInvestigationEvidenceWorker().createRetainedDownloadTimingEvidence({ request: createOrdinaryDownloadTimingEvidenceFile({ snapshot: source, association: { kind: 'retained-export', exportId: 'empty', investigation: 'not-run' } }) })).rejects.toThrow('No retained Download timing');
  });
});
