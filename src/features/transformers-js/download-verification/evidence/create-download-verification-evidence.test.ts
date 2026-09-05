import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createDownloadVerificationEvidence } from '@/features/transformers-js/download-verification/evidence/create-download-verification-evidence';
import type { DownloadVerificationEvidenceInput } from '@/features/transformers-js/download-verification/evidence/types';

function sampleEvidence(): DownloadVerificationEvidenceInput {
  const revision = '0123456789abcdef0123456789abcdef01234567';
  return {
    schemaVersion: 1,
    runId: 'run-download-1',
    mode: 'probe-only',
    run: {
      modelId: 'hf.co/LiquidAI/LFM2.5-230M-ONNX',
      normalizedModelId: 'LiquidAI/LFM2.5-230M-ONNX',
      requestedRevision: 'main',
      resolvedRevision: revision,
      repositoryFileCount: 2,
      repositoryFiles: [
        { path: 'onnx/model_q4.onnx', size: 154010, blobId: undefined, lfsOid: undefined, lfsSha256: undefined, lfsSize: undefined },
        { path: 'onnx/model_q4.onnx_data', size: 211111936, blobId: undefined, lfsOid: undefined, lfsSha256: undefined, lfsSize: undefined },
      ],
      transportObservations: [{
        path: 'onnx/model_q4.onnx_data',
        method: 'HEAD',
        status: 200,
        redirected: true,
        finalUrl: 'https://us.aws.cdn.hf.co/path/model_q4.onnx_data',
        finalOrigin: 'https://us.aws.cdn.hf.co',
        contentLength: 211111936,
        contentRange: undefined,
        acceptRanges: 'bytes',
        contentType: 'application/octet-stream',
        etag: undefined,
        rangeHonored: undefined,
        bytesConsumed: 0,
        abortedByByteBudget: false,
        error: undefined,
      }],
      skippedModelArtifactCount: 0,
      bytesConsumed: 0,
      maximumBytes: 2 * 1024 * 1024,
      startedAt: '2026-09-04T00:00:00.000Z',
      finishedAt: '2026-09-04T00:00:01.000Z',
    },
    modelArtifactObservations: [
      {
        modelId: 'LiquidAI/LFM2.5-230M-ONNX',
        revision,
        autoClass: 'AutoModelForCausalLM',
        candidate: { device: 'webgpu', dtype: 'q4f16' },
        status: 'observed',
        observationMethod: 'held-model-artifact-fetch-quiescence',
        quiescenceMs: 500,
        timeoutMs: 10_000,
        paths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
        requests: [
          { path: 'onnx/model_q4f16.onnx', url: `https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/${revision}/onnx/model_q4f16.onnx` },
          { path: 'onnx/model_q4f16.onnx_data', url: `https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/${revision}/onnx/model_q4f16.onnx_data` },
        ],
        error: undefined,
      },
      {
        modelId: 'LiquidAI/LFM2.5-230M-ONNX',
        revision,
        autoClass: 'AutoModelForCausalLM',
        candidate: { device: 'webgpu', dtype: 'q4' },
        status: 'observed',
        observationMethod: 'held-model-artifact-fetch-quiescence',
        quiescenceMs: 500,
        timeoutMs: 10_000,
        paths: ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'],
        requests: [
          { path: 'onnx/model_q4.onnx', url: `https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/${revision}/onnx/model_q4.onnx` },
          { path: 'onnx/model_q4.onnx_data', url: `https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/${revision}/onnx/model_q4.onnx_data` },
        ],
        error: undefined,
      },
      {
        modelId: 'LiquidAI/LFM2.5-230M-ONNX',
        revision,
        autoClass: 'AutoModelForCausalLM',
        candidate: { device: 'wasm', dtype: 'q4' },
        status: 'observed',
        observationMethod: 'held-model-artifact-fetch-quiescence',
        quiescenceMs: 500,
        timeoutMs: 10_000,
        paths: ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'],
        requests: [
          { path: 'onnx/model_q4.onnx', url: `https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/${revision}/onnx/model_q4.onnx` },
          { path: 'onnx/model_q4.onnx_data', url: `https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/${revision}/onnx/model_q4.onnx_data` },
        ],
        error: undefined,
      },
    ],
    modelArtifactObservationError: undefined,
    cacheBefore: {
      modelId: 'LiquidAI/LFM2.5-230M-ONNX',
      normalizedModelId: 'LiquidAI/LFM2.5-230M-ONNX',
      revisions: [],
    },
    cacheInspectionError: undefined,
  };
}

describe('createDownloadVerificationEvidence', () => {
  it('exports probe-only evidence with LFM q4f16 absence and q4 presence preserved for regression tests', async () => {
    const { blob, fileName } = await createDownloadVerificationEvidence({ evidence: sampleEvidence() });
    expect(fileName).toContain('LiquidAI-LFM2.5-230M-ONNX');

    const zip = await JSZip.loadAsync(blob);
    expect(zip.file('manifest.json')).not.toBeNull();
    expect(zip.file('test-readiness.json')).not.toBeNull();
    expect(zip.file('download-lane/repository.json')).not.toBeNull();
    expect(zip.file('download-lane/artifact-requests.json')).not.toBeNull();
    expect(zip.file('download-lane/candidates.json')).not.toBeNull();
    expect(zip.file('download-lane/cache-acceptance.json')).not.toBeNull();

    const candidates = JSON.parse(await zip.file('download-lane/candidates.json')!.async('text')) as {
      candidates: Array<{ candidate: { device: string; dtype: string }; status: string; missingRepositoryPaths: string[] }>;
      firstRepositoryCompleteCandidate: { device: string; dtype: string } | null;
    };
    expect(candidates.candidates[0]).toMatchObject({
      candidate: { device: 'webgpu', dtype: 'q4f16' },
      status: 'repository-incomplete',
      missingRepositoryPaths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
    });
    expect(candidates.candidates[1]).toMatchObject({
      candidate: { device: 'webgpu', dtype: 'q4' },
      status: 'repository-complete',
      missingRepositoryPaths: [],
    });
    expect(candidates.firstRepositoryCompleteCandidate).toEqual({ device: 'webgpu', dtype: 'q4' });

    const readiness = JSON.parse(await zip.file('test-readiness.json')!.async('text')) as {
      domains: Array<{ domain: string; status: string; evidencePaths: string[] }>;
    };
    expect(readiness.domains.find(domain => domain.domain === 'candidate-resolution')).toMatchObject({
      status: 'implementation-ready',
      evidencePaths: ['download-lane/candidates.json'],
    });
    expect(readiness.domains.find(domain => domain.domain === 'runtime-acceptance')).toMatchObject({
      status: 'not-observed',
      evidencePaths: ['download-lane/cache-acceptance.json'],
    });

    const events = (await zip.file('download-lane/events.jsonl')!.async('text'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events.find(event => event.type === 'artifact-request-observation-completed')).toMatchObject({
      observedCandidateCount: 3,
      failedCandidateCount: 0,
      observationError: null,
    });
  });


  it('records observed and failed artifact-request candidates separately in events', async () => {
    const evidence = sampleEvidence();
    const failed = evidence.modelArtifactObservations[2];
    if (failed === undefined) throw new Error('Expected a third artifact observation fixture');
    evidence.modelArtifactObservations[2] = {
      ...failed,
      status: 'failed',
      paths: [],
      requests: [],
      error: { name: 'ObserverFailure', message: 'candidate observation failed' },
    };

    const { blob } = await createDownloadVerificationEvidence({ evidence });
    const zip = await JSZip.loadAsync(blob);
    const events = (await zip.file('download-lane/events.jsonl')!.async('text'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);

    expect(events.find(event => event.type === 'artifact-request-observation-completed')).toMatchObject({
      observedCandidateCount: 2,
      failedCandidateCount: 1,
      observationError: null,
    });
  });

  it('keeps probe-only evidence free of full model bodies and marks runtime/load evidence unobserved', async () => {
    const { blob } = await createDownloadVerificationEvidence({ evidence: sampleEvidence() });
    const zip = await JSZip.loadAsync(blob);
    const paths = Object.keys(zip.files);
    expect(paths.some(path => path.endsWith('.onnx') || path.endsWith('.onnx_data'))).toBe(false);

    const acceptance = JSON.parse(await zip.file('download-lane/cache-acceptance.json')!.async('text')) as { status: string };
    expect(acceptance.status).toBe('not-run');
    const prefetch = JSON.parse(await zip.file('download-lane/prefetch.json')!.async('text')) as { status: string };
    expect(prefetch.status).toBe('not-run');
  });
});

describe('createDownloadVerificationEvidence runtime-complete mode', () => {
  it('exports accepted cache revision, selected candidate, preparation, and post-run cache without model bodies', async () => {
    const evidence = sampleEvidence();
    evidence.mode = 'runtime-complete';
    evidence.runtimeCompletion = {
      schemaVersion: 1,
      status: 'accepted',
      source: 'production-download-preparation',
      repositoryResolvedRevision: evidence.run.resolvedRevision,
      cacheRevision: evidence.run.resolvedRevision,
      loaderRevisionOption: evidence.run.resolvedRevision,
      selectedCandidate: { device: 'webgpu', dtype: 'q4' },
      cacheReuse: undefined,
      preparation: {
        status: 'accepted',
        failureStage: undefined,
        runtimeArtifacts: {
          modelId: evidence.run.normalizedModelId,
          revision: evidence.run.resolvedRevision,
          status: 'prepared',
          processor: 'tokenizer',
          modelType: 'lfm2',
          observationMethod: 'transformers-runtime-artifact-preparation',
          error: undefined,
        },
        candidates: {
          status: 'accepted',
          selectedCandidate: { device: 'webgpu', dtype: 'q4' },
          attempts: [
            {
              candidate: { device: 'webgpu', dtype: 'q4f16' },
              preparation: {
                status: 'unavailable',
                reason: 'onnx/model_q4f16.onnx',
                prefetch: {
                  requestedCount: 1,
                  cachedCount: 0,
                  downloadedCount: 0,
                  failedCount: 1,
                  complete: false,
                  files: [{
                    status: 'failed',
                    url: `https://huggingface.co/${evidence.run.normalizedModelId}/resolve/${evidence.run.resolvedRevision}/onnx/model_q4f16.onnx`,
                    path: `models/huggingface.co/${evidence.run.normalizedModelId}/resolve/${evidence.run.resolvedRevision}/onnx/model_q4f16.onnx`,
                    failureStage: 'response-status',
                    httpStatus: 404,
                    error: { name: 'Error', message: 'HTTP 404' },
                  }],
                },
              },
              acceptance: undefined,
            },
            {
              candidate: { device: 'webgpu', dtype: 'q4' },
              preparation: {
                status: 'ready',
                prefetch: {
                  requestedCount: 1,
                  cachedCount: 0,
                  downloadedCount: 1,
                  failedCount: 0,
                  complete: true,
                  files: [{
                    status: 'downloaded',
                    url: `https://huggingface.co/${evidence.run.normalizedModelId}/resolve/${evidence.run.resolvedRevision}/onnx/model_q4.onnx`,
                    path: `models/huggingface.co/${evidence.run.normalizedModelId}/resolve/${evidence.run.resolvedRevision}/onnx/model_q4.onnx`,
                    byteLength: 1024,
                    expectedByteLength: 1024,
                  }],
                },
              },
              acceptance: {
                modelId: evidence.run.normalizedModelId,
                resolvedRevision: evidence.run.resolvedRevision,
                loaderRevisionOption: evidence.run.resolvedRevision,
                candidate: { device: 'webgpu', dtype: 'q4' },
                status: 'accepted',
                observationMethod: 'production-cache-only-runtime-preparation',
                error: undefined,
              },
            },
          ],
          error: undefined,
        },
      },
      cacheAfter: {
        modelId: evidence.run.normalizedModelId,
        normalizedModelId: evidence.run.normalizedModelId,
        revisions: [],
      },
      cacheInspectionError: undefined,
      error: undefined,
    };

    const { blob } = await createDownloadVerificationEvidence({ evidence });
    const zip = await JSZip.loadAsync(blob);
    const readiness = JSON.parse(await zip.file('test-readiness.json')!.async('text')) as {
      mode: string;
      domains: Array<{ domain: string; status: string }>;
    };
    expect(readiness.mode).toBe('runtime-complete');
    expect(readiness.domains.find(domain => domain.domain === 'runtime-acceptance')).toMatchObject({ status: 'implementation-ready' });

    const acceptance = JSON.parse(await zip.file('download-lane/cache-acceptance.json')!.async('text')) as {
      status: string;
      cacheRevision: string;
      loaderRevisionOption: string;
      revisionIdentity: string;
      selectedCandidate: { device: string; dtype: string };
    };
    expect(acceptance).toMatchObject({
      status: 'accepted',
      cacheRevision: evidence.run.resolvedRevision,
      loaderRevisionOption: evidence.run.resolvedRevision,
      selectedCandidate: { device: 'webgpu', dtype: 'q4' },
    });

    const prefetch = JSON.parse(await zip.file('download-lane/prefetch.json')!.async('text')) as {
      status: string;
      fileObservations: Array<{
        candidateAttemptIndex: number;
        candidate: { device: string; dtype: string };
        preparationStatus: string;
        file: {
          status: string;
          path?: string;
          failureStage?: string;
          httpStatus?: number;
          error?: { name: string; message: string };
        };
      }>;
    };
    expect(prefetch.status).toBe('accepted');
    expect(prefetch.fileObservations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidateAttemptIndex: 0,
        candidate: { device: 'webgpu', dtype: 'q4f16' },
        preparationStatus: 'unavailable',
        file: expect.objectContaining({
          status: 'failed',
          failureStage: 'response-status',
          httpStatus: 404,
          error: { name: 'Error', message: 'HTTP 404' },
        }),
      }),
      expect.objectContaining({
        candidateAttemptIndex: 1,
        candidate: { device: 'webgpu', dtype: 'q4' },
        preparationStatus: 'ready',
        file: expect.objectContaining({ status: 'downloaded', byteLength: 1024 }),
      }),
    ]));
    expect(Object.keys(zip.files).some(path => path.endsWith('.onnx') || path.endsWith('.onnx_data'))).toBe(false);
  });

  it('keeps runtime acceptance partial when a Production-accepted legacy main cache has unverified exact revision identity', async () => {
    const evidence = sampleEvidence();
    evidence.mode = 'runtime-complete';
    evidence.runtimeCompletion = {
      schemaVersion: 1,
      status: 'accepted',
      source: 'reused-production-cache',
      repositoryResolvedRevision: evidence.run.resolvedRevision,
      cacheRevision: 'main',
      loaderRevisionOption: null,
      selectedCandidate: { device: 'webgpu', dtype: 'q4' },
      cacheReuse: undefined,
      preparation: undefined,
      cacheAfter: undefined,
      cacheInspectionError: undefined,
      error: undefined,
    };

    const { blob } = await createDownloadVerificationEvidence({ evidence });
    const zip = await JSZip.loadAsync(blob);
    const readiness = JSON.parse(await zip.file('test-readiness.json')!.async('text')) as {
      overall: string;
      domains: Array<{ domain: string; status: string; summary: string }>;
    };
    expect(readiness.overall).toBe('partial');
    expect(readiness.domains.find(domain => domain.domain === 'runtime-acceptance')).toMatchObject({
      status: 'partial',
      summary: expect.stringContaining('exact identity'),
    });

    const acceptance = JSON.parse(await zip.file('download-lane/cache-acceptance.json')!.async('text')) as { revisionIdentity: string };
    expect(acceptance.revisionIdentity).toBe('legacy-main-unverified');
  });
});
