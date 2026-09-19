import { afterEach, expect, it, vi } from 'vitest';
import { createDownloadVerificationCandidateAcceptanceWorkerClient } from '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted';
import { reuseDownloadedProductionRevision } from './reuse-downloaded-production-revision';
import { downloadedModelCandidatePlanError, planDownloadedModelCandidates } from '@/features/transformers-js/runtime/plan-downloaded-model-candidates';
import { ProductionResourceCandidateError } from '@/features/transformers-js/runtime/production-resource-plan';
import { createRequiredDownloadedResourceOperation, RequiredDownloadedResourceCleanupError } from '@/features/transformers-js/runtime/required-downloaded-resource-operation';
import { acceptDownloadedProductionCandidate } from './accept-downloaded-production-candidate';
import { acceptDownloadedProductionRevision } from './accept-downloaded-production-revision';
import { ProductionWorkerLifecycleError } from '@/features/transformers-js/worker/production-worker-session';

vi.mock('../candidate-acceptance-worker/client-hosted', () => ({
  createDownloadVerificationCandidateAcceptanceWorkerClient: vi.fn(),
}));

afterEach(() => vi.unstubAllGlobals());

it('never reclassifies a post-plan required resource failure as repairable missing across candidate and revision fallback', async () => {
  const modelId = 'org/model';
  const revision = '1'.repeat(40);
  const forbiddenFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('Unexpected network');
  });
  vi.stubGlobal('fetch', forbiddenFetch);
  const put = vi.fn();
  const verifyDownloadedModelCandidate = vi.fn(async () => {
    const operation = createRequiredDownloadedResourceOperation({
      modelId, revision, requiredPaths: ['onnx/model_q4f16.onnx'], workerLocationUrl: 'https://naidan.example/worker.js',
      modelCache: { match: async () => undefined, put }, cacheOnlyFetch: forbiddenFetch,
    });
    try {
      await operation.cache.match(`https://huggingface.co/${modelId}/resolve/${revision}/onnx/model_q4f16.onnx`).catch(() => undefined);
      operation.assertHealthy();
      throw new Error('Required operation unexpectedly succeeded');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // Model/cache failure originated in the real ownership helper; emulate
      // only Comlink's Error reconstruction at this client factory boundary.
      throw Object.assign(new Error(error.message), { name: error.name });
    } finally {
      await operation.close();
    }
  });
  const dispose = vi.fn(async () => {});
  vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
    verifyDownloadedModelCandidate, verifyDownloadedModelRevision: vi.fn(), dispose,
  });
  const startFreshDownload = vi.fn();
  const operation = (async () => {
    const reuse = await reuseDownloadedProductionRevision({
      modelId, resolvedRevision: revision, storageRoot: {} as FileSystemDirectoryHandle,
      candidateOrderByRevision: {
        [revision]: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }],
        main: [{ device: 'webgpu', dtype: 'q4' }],
      },
      inspectCachedRevisions: async () => ({
        modelId, normalizedModelId: modelId,
        revisions: [
          { revision, kind: 'immutable-sha', totalBytes: 3, fileCount: 1, completionMarkerCount: 1, incompleteFileCount: 0, zeroByteFileCount: 0, weightFileCount: 1, committedWeightFileCount: 1, lastModified: 1, status: 'committed-file-set' },
          { revision: 'main', kind: 'legacy-main', totalBytes: 3, fileCount: 1, completionMarkerCount: 1, incompleteFileCount: 0, zeroByteFileCount: 0, weightFileCount: 1, committedWeightFileCount: 1, lastModified: 1, status: 'committed-file-set' },
        ],
      }),
    });
    if (!reuse.reused) startFreshDownload();
  })();
  await expect(operation).rejects.toThrow('RequiredDownloadedModelResourceError');
  expect(verifyDownloadedModelCandidate).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(startFreshDownload).not.toHaveBeenCalled();
  expect(forbiddenFetch).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

it('treats a transported resource cleanup deadline as terminal candidate failure', async () => {
  const original = new RequiredDownloadedResourceCleanupError({ cause: new Error('Fixture held reader') });
  const error = Object.assign(new Error(original.message), { name: original.name });
  const dispose = vi.fn(async () => {});
  vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
    verifyDownloadedModelCandidate: vi.fn(async () => {
      throw error;
    }),
    verifyDownloadedModelRevision: vi.fn(), dispose,
  });
  await expect(acceptDownloadedProductionCandidate({
    modelId: 'org/model', resolvedRevision: '1'.repeat(40), candidate: { device: 'webgpu', dtype: 'q4f16' },
  })).resolves.toMatchObject({ status: 'failed', error: { name: 'RequiredDownloadedResourceCleanupError' } });
  expect(dispose).toHaveBeenCalledOnce();
});

it('stops candidate fallback when the session owner wraps cleanup as a lifecycle error', async () => {
  const original = new ProductionWorkerLifecycleError({ reason: 'resource-cleanup-failed', message: 'Fixture owner terminated after cleanup deadline' });
  const error = Object.assign(new Error(original.message), { name: original.name });
  const verifyDownloadedModelCandidate = vi.fn(async () => {
    throw error;
  });
  const dispose = vi.fn(async () => {});
  vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
    verifyDownloadedModelCandidate, verifyDownloadedModelRevision: vi.fn(), dispose,
  });
  await expect(acceptDownloadedProductionRevision({
    modelId: 'org/model', repositoryResolvedRevision: '1'.repeat(40), cacheRevision: '1'.repeat(40), loadRevision: '1'.repeat(40),
    candidates: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }],
  })).resolves.toMatchObject({ status: 'failed', error: { name: 'ProductionWorkerLifecycleError' } });
  expect(verifyDownloadedModelCandidate).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
});

it('does not grant cache repair authority to a runtime error that merely quotes the offline policy', async () => {
  const error = Object.assign(new Error('Runtime diagnostic quotes MUST NOT fetch model artifacts'), { name: 'RuntimeRejectedError' });
  vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
    verifyDownloadedModelCandidate: vi.fn(), verifyDownloadedModelRevision: vi.fn(async () => {
      throw error;
    }), dispose: vi.fn(async () => {}),
  });
  await expect(acceptDownloadedProductionRevision({
    modelId: 'org/model', repositoryResolvedRevision: '1'.repeat(40), cacheRevision: '1'.repeat(40), loadRevision: '1'.repeat(40),
  })).resolves.toMatchObject({ status: 'rejected', error: { name: 'RuntimeRejectedError' } });
});

it('keeps planning failure distinct from repairable missing files through revision acceptance and reuse', async () => {
  const modelId = 'org/model';
  const revision = '1'.repeat(40);
  const forbiddenFetch = vi.fn(() => {
    throw new Error('Unexpected network request');
  });
  vi.stubGlobal('fetch', forbiddenFetch);
  const match = vi.fn();
  const dispose = vi.fn(async () => {});
  const verifyDownloadedModelRevision = vi.fn(async () => {
    const entries = await planDownloadedModelCandidates({
      modelId, revision,
      candidates: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }, { device: 'wasm', dtype: 'q4' }],
      modelCache: { match },
      getModelFiles: async ({ candidate }) => {
        throw new ProductionResourceCandidateError({ candidate, cause: new Error('Invalid selected external-data count') });
      },
      getRuntimeFiles: async () => [],
      workerLocationUrl: 'https://naidan.example/assets/worker.js',
    });
    // The Worker transport preserves Error.name/message, not the class identity.
    const error = downloadedModelCandidatePlanError({ modelId, revision, entries });
    throw Object.assign(new Error(error.message), { name: error.name });
  });
  vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
    verifyDownloadedModelRevision,
    verifyDownloadedModelCandidate: vi.fn(),
    dispose,
  });
  const startFreshDownload = vi.fn();
  const operation = (async () => {
    const reuse = await reuseDownloadedProductionRevision({
      modelId, resolvedRevision: revision, storageRoot: {} as FileSystemDirectoryHandle,
      inspectCachedRevisions: async () => ({
        modelId, normalizedModelId: modelId,
        revisions: [{
          revision, kind: 'immutable-sha', totalBytes: 3, fileCount: 1, completionMarkerCount: 1,
          incompleteFileCount: 0, zeroByteFileCount: 0, weightFileCount: 1, committedWeightFileCount: 1,
          lastModified: 1, status: 'committed-file-set',
        }],
      }),
    });
    if (!reuse.reused) startFreshDownload();
  })();
  await expect(operation).rejects.toThrow('DownloadedModelResourcePlanningError: No Production candidate could be planned');
  expect(startFreshDownload).not.toHaveBeenCalled();
  expect(verifyDownloadedModelRevision).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(match).not.toHaveBeenCalled();
  expect(forbiddenFetch).not.toHaveBeenCalled();
});
