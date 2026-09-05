import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptDownloadedProductionRevision } from '@/features/transformers-js/download-verification/logic/accept-downloaded-production-revision';
import {
  createDownloadVerificationCandidateAcceptanceWorkerClient,
  type DownloadVerificationCandidateAcceptanceWorkerClient,
} from '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted';

vi.mock('@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted', () => ({
  createDownloadVerificationCandidateAcceptanceWorkerClient: vi.fn(),
}));

const REVISION = '0123456789abcdef0123456789abcdef01234567';

beforeEach(() => {
  vi.clearAllMocks();
});

function client({ verifyDownloadedModelRevision }: {
  verifyDownloadedModelRevision: DownloadVerificationCandidateAcceptanceWorkerClient['verifyDownloadedModelRevision'];
}): DownloadVerificationCandidateAcceptanceWorkerClient {
  return {
    verifyDownloadedModelCandidate: vi.fn(),
    verifyDownloadedModelRevision,
    dispose: vi.fn(async () => {}),
  };
}

describe('acceptDownloadedProductionRevision', () => {
  it('verifies an exact revision through the full Production candidate fallback sequence', async () => {
    const worker = client({ verifyDownloadedModelRevision: vi.fn(async () => ({ device: 'webgpu' as const, dtype: 'q4' as const })) });
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue(worker);

    const result = await acceptDownloadedProductionRevision({
      modelId: 'org/model',
      repositoryResolvedRevision: REVISION,
      cacheRevision: REVISION,
      loadRevision: REVISION,
    });

    expect(result).toEqual({
      modelId: 'org/model',
      repositoryResolvedRevision: REVISION,
      cacheRevision: REVISION,
      loaderRevisionOption: REVISION,
      status: 'accepted',
      selectedDevice: 'webgpu',
      selectedDtype: 'q4',
      observationMethod: 'production-cache-only-revision-runtime-preparation',
      error: undefined,
    });
    expect(worker.verifyDownloadedModelRevision).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'org/model',
      loadRevision: REVISION,
    }));
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  it('classifies a missing required cache artifact as failed, not runtime rejected', async () => {
    const worker = client({ verifyDownloadedModelRevision: vi.fn(async () => {
      throw new Error('loadDownloadedModel() MUST NOT fetch model artifacts; missing https://huggingface.co/org/model/resolve/main/onnx/model_q4.onnx?secret=1');
    }) });
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue(worker);

    const result = await acceptDownloadedProductionRevision({
      modelId: 'org/model',
      repositoryResolvedRevision: REVISION,
      cacheRevision: 'main',
    });

    expect(result.status).toBe('failed');
    expect(result.error?.name).toBe('MissingDownloadedModelArtifact');
    expect(result.error?.message).toContain('MUST NOT fetch model artifacts');
    expect(result.error?.message).not.toContain('secret=1');
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  it('reports all-candidate runtime rejection separately from cache incompleteness', async () => {
    const worker = client({ verifyDownloadedModelRevision: vi.fn(async () => {
      throw new Error('WASM q4 runtime rejected');
    }) });
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue(worker);

    const result = await acceptDownloadedProductionRevision({
      modelId: 'org/model',
      repositoryResolvedRevision: REVISION,
      cacheRevision: REVISION,
      loadRevision: REVISION,
    });

    expect(result.status).toBe('rejected');
    expect(result.selectedDevice).toBeUndefined();
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  it('disposes the active worker when aborted', async () => {
    const worker = client({ verifyDownloadedModelRevision: vi.fn(async () => await new Promise<{ device: string }>(() => {})) });
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue(worker);
    const controller = new AbortController();
    const operation = acceptDownloadedProductionRevision({
      modelId: 'org/model',
      repositoryResolvedRevision: REVISION,
      cacheRevision: REVISION,
      loadRevision: REVISION,
      signal: controller.signal,
    });
    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  it('records an offline legacy-main acceptance without inventing a resolved commit SHA', async () => {
    const worker = client({ verifyDownloadedModelRevision: vi.fn(async () => ({ device: 'wasm' as const, dtype: 'q4' as const })) });
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue(worker);

    const result = await acceptDownloadedProductionRevision({
      modelId: 'org/model',
      repositoryResolvedRevision: undefined,
      cacheRevision: 'main',
    });

    expect(result).toMatchObject({
      repositoryResolvedRevision: null,
      cacheRevision: 'main',
      loaderRevisionOption: null,
      status: 'accepted',
      selectedDevice: 'wasm',
      selectedDtype: 'q4',
    });
  });

  it('fails before Worker creation when cache and loader revision identities disagree', async () => {
    await expect(acceptDownloadedProductionRevision({
      modelId: 'org/model',
      repositoryResolvedRevision: REVISION,
      cacheRevision: REVISION,
      loadRevision: 'f'.repeat(40),
    })).rejects.toThrow('does not match the cache revision');
    expect(createDownloadVerificationCandidateAcceptanceWorkerClient).not.toHaveBeenCalled();
  });
});
