import { describe, expect, it } from 'vitest';
import { productionLoadReceiptSchema, type ProductionLoadReceipt } from '@/features/transformers-js/runtime/production-load-receipt';
import type { DownloadVerificationEvidenceInput } from './types';
import { downloadRuntimeAcceptanceIdentity } from './runtime-acceptance-identity';

const revision = 'a'.repeat(40);
const paths = ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'];
function receipt({ cacheRevision, option }: { cacheRevision: string; option: string | undefined }) {
  return productionLoadReceiptSchema.parse({
    format: 'production-offline-load-receipt-v1', modelId: 'fixture/model',
    loaderRevisionOption: option === undefined ? { status: 'omitted' } : { status: 'provided', value: option },
    autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', candidate: { device: 'wasm', dtype: 'q4' },
    plannedRequiredPaths: ['config.json', ...paths],
    cacheLookup: { source: 'read-only-opfs-scoped-match', revision: cacheRevision, hitPaths: ['config.json', ...paths] },
    completion: 'model-session-and-tokenizer-processor-ready', resourceHealth: 'healthy-after-close', accessBoundary: 'production-offline-read-only',
    limitations: { wholeFileProvenance: 'not-verified', allPlannedBodiesConsumed: 'not-certified' },
  });
}

function evidence({ loadReceipt }: { loadReceipt: ProductionLoadReceipt | undefined }): DownloadVerificationEvidenceInput {
  return {
    schemaVersion: 1, runId: 'receipt-identity', mode: 'runtime-complete',
    run: { modelId: 'fixture/model', normalizedModelId: 'fixture/model', requestedRevision: 'main', resolvedRevision: revision,
      repositoryFileCount: paths.length, repositoryFiles: paths.map(path => ({ path, size: 16, blobId: undefined, lfsOid: undefined, lfsSha256: undefined, lfsSize: undefined })),
      transportObservations: [], skippedModelArtifactCount: 0, bytesConsumed: 0, maximumBytes: 1024,
      startedAt: '2026-09-10T00:00:00.000Z', finishedAt: '2026-09-10T00:00:01.000Z' },
    modelArtifactObservations: [{ modelId: 'fixture/model', revision, autoClass: 'AutoModelForCausalLM', candidate: { device: 'wasm', dtype: 'q4' },
      status: 'observed', observationMethod: 'held-model-artifact-fetch-quiescence', quiescenceMs: 500, timeoutMs: 10_000,
      paths: [...paths], requests: paths.map(path => ({ path, url: `https://huggingface.co/fixture/model/resolve/${revision}/${path}` })), error: undefined }],
    modelArtifactObservationError: undefined, cacheBefore: undefined, cacheInspectionError: undefined,
    runtimeCompletion: { schemaVersion: 1, status: 'accepted', source: 'ordinary-provider-load', repositoryResolvedRevision: revision,
      cacheRevision: loadReceipt?.cacheLookup.revision ?? revision,
      loaderRevisionOption: loadReceipt?.loaderRevisionOption.status === 'provided' ? loadReceipt.loaderRevisionOption.value : null,
      selectedCandidate: loadReceipt?.candidate ?? { device: 'wasm', dtype: 'q4' },
      cacheReuse: undefined, preparation: undefined, cacheAfter: undefined, cacheInspectionError: undefined, error: undefined,
      receipt: loadReceipt },
  };
}

describe('Download runtime acceptance identity', () => {
  it('requires an actual healthy receipt plus same frozen revision, candidate and artifact paths for exact acceptance', () => {
    const input = evidence({ loadReceipt: receipt({ cacheRevision: revision, option: revision }) });
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBe('exact-resolved-revision');
    expect(input.runtimeCompletion?.status).toBe('accepted');
    expect(input.runtimeCompletion?.receipt?.limitations.allPlannedBodiesConsumed).toBe('not-certified');
  });

  it.each(['b'.repeat(40), 'main'])('preserves accepted local Load without certifying the frozen SHA: %s', cacheRevision => {
    const input = evidence({ loadReceipt: receipt({ cacheRevision, option: cacheRevision === 'main' ? undefined : cacheRevision }) });
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBe(cacheRevision === 'main' ? 'legacy-main-unverified' : 'unverified');
    expect(input.runtimeCompletion?.status).toBe('accepted');
    expect(input.runtimeCompletion?.cacheRevision).toBe(cacheRevision);
  });

  it('does not infer a receipt from older accepted evidence, or acceptance from a failed/missing completion', () => {
    const input = evidence({ loadReceipt: undefined });
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBe('unverified');
    input.runtimeCompletion!.status = 'failed';
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBeUndefined();
    delete input.runtimeCompletion;
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBeUndefined();
  });

  it.each(['model', 'cache', 'loader-option', 'candidate', 'frozen-revision', 'invalid-receipt'] as const)('refuses inconsistent completion or receipt identity: %s', mismatch => {
    const input = evidence({ loadReceipt: receipt({ cacheRevision: revision, option: revision }) });
    const completion = input.runtimeCompletion!;
    switch (mismatch) {
    case 'model': input.run.normalizedModelId = 'fixture/other'; break;
    case 'cache': completion.cacheRevision = 'b'.repeat(40); break;
    case 'loader-option': completion.loaderRevisionOption = null; break;
    case 'candidate': completion.selectedCandidate = { device: 'webgpu', dtype: 'q4f16' }; break;
    case 'frozen-revision': completion.repositoryResolvedRevision = 'b'.repeat(40); break;
    case 'invalid-receipt': completion.receipt!.cacheLookup.hitPaths = []; break;
    default: { const exhaustive: never = mismatch; throw new Error('Unexpected receipt mismatch: ' + exhaustive); }
    }
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBe('unverified');
  });

  it.each(['failed', 'missing', 'extra-path', 'missing-path', 'auto-class', 'candidate', 'revision'] as const)('does not certify absent, failed or different artifact-request observations: %s', mismatch => {
    const input = evidence({ loadReceipt: receipt({ cacheRevision: revision, option: revision }) });
    const observation = input.modelArtifactObservations[0]!;
    switch (mismatch) {
    case 'failed': observation.status = 'failed'; observation.error = { name: 'Error', message: 'Synthetic observer failure' }; break;
    case 'missing': input.modelArtifactObservations = []; break;
    case 'extra-path': observation.paths.push('onnx/extra.onnx'); break;
    case 'missing-path': observation.paths.pop(); break;
    case 'auto-class': observation.autoClass = 'AutoModelForImageTextToText'; break;
    case 'candidate': observation.candidate = { device: 'webgpu', dtype: 'q4f16' }; break;
    case 'revision': observation.revision = 'b'.repeat(40); break;
    default: { const exhaustive: never = mismatch; throw new Error('Unexpected observation mismatch: ' + exhaustive); }
    }
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBe('unverified');
    expect(input.runtimeCompletion?.status).toBe('accepted');
  });

  it.each(['observed-with-error', 'global-observer-error'] as const)('refuses contradictory successful artifact observations: %s', contradiction => {
    const input = evidence({ loadReceipt: receipt({ cacheRevision: revision, option: revision }) });
    switch (contradiction) {
    case 'observed-with-error': input.modelArtifactObservations[0]!.error = { name: 'Error', message: 'Observer reported an error' }; break;
    case 'global-observer-error': input.modelArtifactObservationError = 'Partial observer failure'; break;
    default: { const exhaustive: never = contradiction; throw new Error('Unexpected observer contradiction: ' + exhaustive); }
    }
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBe('unverified');
    expect(input.runtimeCompletion?.status).toBe('accepted');
  });

  it('does not erase selected-candidate identity merely because a different candidate failed its probe', () => {
    const input = evidence({ loadReceipt: receipt({ cacheRevision: revision, option: revision }) });
    input.modelArtifactObservations.push({ ...input.modelArtifactObservations[0]!, candidate: { device: 'webgpu', dtype: 'q4f16' },
      status: 'failed', paths: [], requests: [], error: { name: 'Error', message: 'Different candidate probe failed' } });
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBe('exact-resolved-revision');
    expect(input.modelArtifactObservations[1]!.status).toBe('failed');
  });

  it.each(['observed', 'failed'] as const)('does not certify duplicate observations for the same identity: %s', status => {
    const input = evidence({ loadReceipt: receipt({ cacheRevision: revision, option: revision }) });
    input.modelArtifactObservations.push({ ...input.modelArtifactObservations[0]!, status,
      error: status === 'failed' ? { name: 'Error', message: 'Conflicting same-candidate probe failed' } : undefined });
    expect(downloadRuntimeAcceptanceIdentity({ evidence: input })).toBe('unverified');
    expect(input.runtimeCompletion?.status).toBe('accepted');
  });
});
