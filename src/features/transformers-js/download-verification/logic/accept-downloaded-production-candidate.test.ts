import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptDownloadedProductionCandidate } from '@/features/transformers-js/download-verification/logic/accept-downloaded-production-candidate';
import { createDownloadVerificationCandidateAcceptanceWorkerClient } from '@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted';

vi.mock('@/features/transformers-js/download-verification/candidate-acceptance-worker/client-hosted', () => ({
  createDownloadVerificationCandidateAcceptanceWorkerClient: vi.fn(),
}));

const REVISION = '0123456789abcdef0123456789abcdef01234567';
const CANDIDATE = { device: 'webgpu', dtype: 'q4f16' } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('acceptDownloadedProductionCandidate', () => {
  it('uses one fresh acceptance worker and disposes it after success', async () => {
    const dispose = vi.fn(async () => {});
    const verifyDownloadedModelCandidate = vi.fn(async () => ({ device: 'webgpu' }));
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
      verifyDownloadedModelCandidate,
      verifyDownloadedModelRevision: vi.fn(),
      dispose,
    });

    const result = await acceptDownloadedProductionCandidate({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      candidate: CANDIDATE,
    });

    expect(result).toMatchObject({
      status: 'accepted',
      resolvedRevision: REVISION,
      loaderRevisionOption: null,
      candidate: CANDIDATE,
    });
    expect(verifyDownloadedModelCandidate).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'org/model',
      loadRevision: undefined,
      candidate: CANDIDATE,
    }));
    expect(dispose).toHaveBeenCalledOnce();
  });



  it('preserves an accepted candidate when dedicated worker disposal reports a remote release failure', async () => {
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
      verifyDownloadedModelCandidate: vi.fn(async () => ({ device: 'webgpu' })),
      verifyDownloadedModelRevision: vi.fn(),
      dispose: vi.fn(async () => {
        throw new Error('remote release failed');
      }),
    });

    await expect(acceptDownloadedProductionCandidate({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      candidate: CANDIDATE,
    })).resolves.toMatchObject({
      status: 'accepted',
      candidate: CANDIDATE,
    });
  });

  it('records a sanitized rejection and still disposes the worker', async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
      verifyDownloadedModelCandidate: vi.fn(async () => {
        throw new Error('failed at https://cdn.example.test/file?X-Amz-Signature=secret');
      }),
      verifyDownloadedModelRevision: vi.fn(),
      dispose,
    });

    const result = await acceptDownloadedProductionCandidate({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      candidate: CANDIDATE,
    });

    expect(result.status).toBe('rejected');
    expect(result.error?.message).toBe('failed at https://cdn.example.test/file');
    expect(result.error?.message).not.toContain('secret');
    expect(dispose).toHaveBeenCalledOnce();
  });


  it('treats a cache-only missing artifact as a verification failure instead of a runtime rejection', async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
      verifyDownloadedModelCandidate: vi.fn(async () => {
        throw new Error('loadDownloadedModel() MUST NOT fetch model artifacts; the required file is not in the downloaded-model cache: https://huggingface.co/org/model/resolve/main/onnx/model.onnx');
      }),
      verifyDownloadedModelRevision: vi.fn(),
      dispose,
    });

    const result = await acceptDownloadedProductionCandidate({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      candidate: CANDIDATE,
    });

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('MUST NOT fetch model artifacts');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the active worker when aborted', async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(createDownloadVerificationCandidateAcceptanceWorkerClient).mockReturnValue({
      verifyDownloadedModelCandidate: vi.fn(async () => await new Promise<{ device: string }>(() => {})),
      verifyDownloadedModelRevision: vi.fn(),
      dispose,
    });
    const controller = new AbortController();
    const operation = acceptDownloadedProductionCandidate({
      modelId: 'org/model',
      resolvedRevision: REVISION,
      candidate: CANDIDATE,
      signal: controller.signal,
    });
    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
