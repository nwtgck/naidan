import { describe, expect, it } from 'vitest';
import type { DownloadVerificationEvidenceInput } from '@/features/transformers-js/download-verification/evidence/types';
import { downloadProbeOutcome } from './download-probe-outcome';

function evidence(): DownloadVerificationEvidenceInput {
  return {
    schemaVersion: 1, runId: 'probe-run', mode: 'probe-only',
    run: { modelId: 'org/model', normalizedModelId: 'org/model', requestedRevision: 'main', resolvedRevision: 'a'.repeat(40),
      repositoryFileCount: 1, repositoryFiles: [], transportObservations: [], skippedModelArtifactCount: 0,
      bytesConsumed: 0, maximumBytes: 1024, startedAt: '2026-09-10T00:00:00.000Z', finishedAt: '2026-09-10T00:00:01.000Z' },
    modelArtifactObservations: [{ modelId: 'org/model', revision: 'a'.repeat(40), autoClass: 'AutoModelForCausalLM',
      candidate: { device: 'webgpu', dtype: 'q4f16' }, status: 'observed', observationMethod: 'held-model-artifact-fetch-quiescence',
      quiescenceMs: 1, timeoutMs: 100, paths: ['onnx/model.onnx'], requests: [], error: undefined }],
    modelArtifactObservationError: undefined, cacheBefore: undefined, cacheInspectionError: undefined,
  };
}

describe('downloadProbeOutcome', () => {
  it('ends successful bounded observations without certifying runtime acceptance', () => {
    const input = evidence();
    expect(downloadProbeOutcome({ evidence: input })).toMatchObject({ status: 'passed', errors: [] });
    expect(downloadProbeOutcome({ evidence: input }).detail).toContain('runtime cache acceptance is a separate observation');
    expect(input.runtimeCompletion).toBeUndefined();
  });

  it('retains a failed candidate observation even when another candidate was observed', () => {
    const input = evidence();
    input.modelArtifactObservations.push({ ...input.modelArtifactObservations[0]!, candidate: { device: 'wasm', dtype: 'q4' },
      status: 'failed', error: { name: 'TypeError', message: 'Artifact observer rejected' } });
    expect(downloadProbeOutcome({ evidence: input })).toMatchObject({ status: 'failed', errors: [{ name: 'TypeError', message: 'Artifact observer rejected' }] });
  });

  it('preserves resolved collector errors and transport failures', () => {
    const input = evidence();
    input.modelArtifactObservationError = 'Observer unavailable';
    input.cacheInspectionError = 'Cache inventory unreadable';
    input.run.transportObservations.push({ path: 'onnx/model.onnx', method: 'HEAD', status: undefined, redirected: undefined,
      finalUrl: undefined, finalOrigin: undefined, contentLength: undefined, contentRange: undefined, acceptRanges: undefined,
      contentType: undefined, etag: undefined, rangeHonored: undefined, bytesConsumed: 0, abortedByByteBudget: false,
      error: { name: 'NetworkError', message: 'Bounded probe failed' } });
    expect(downloadProbeOutcome({ evidence: input })).toMatchObject({ status: 'failed', errors: [
      { name: 'ArtifactObservationError', message: 'Observer unavailable' },
      { name: 'CacheInspectionError', message: 'Cache inventory unreadable' },
      { name: 'NetworkError', message: 'Bounded probe failed' },
    ] });
  });

  it('ends missing artifact observations as blocked rather than pending or successful', () => {
    const input = evidence();
    input.modelArtifactObservations = [];
    expect(downloadProbeOutcome({ evidence: input })).toMatchObject({ status: 'blocked', errors: [] });
  });
});
