import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runProductionDownloadPreparation } from '@/features/transformers-js/download-verification/logic/run-production-download-preparation';
import { prepareProductionRuntimeArtifacts } from '@/features/transformers-js/download-verification/logic/prepare-production-runtime-artifacts';
import { prepareProductionModelCandidate } from '@/features/transformers-js/download-verification/logic/prepare-production-model-candidate';
import { acceptDownloadedProductionCandidate } from '@/features/transformers-js/download-verification/logic/accept-downloaded-production-candidate';
import type { TransformersJsPrefetchResult } from '@/features/transformers-js/types';

vi.mock('@/features/transformers-js/download-verification/logic/prepare-production-runtime-artifacts', () => ({
  prepareProductionRuntimeArtifacts: vi.fn(),
}));
vi.mock('@/features/transformers-js/download-verification/logic/prepare-production-model-candidate', () => ({
  prepareProductionModelCandidate: vi.fn(),
}));
vi.mock('@/features/transformers-js/download-verification/logic/accept-downloaded-production-candidate', () => ({
  acceptDownloadedProductionCandidate: vi.fn(),
}));

const MODEL_ID = 'org/model';
const REVISION = '0123456789abcdef0123456789abcdef01234567';

function emptyPrefetch(): TransformersJsPrefetchResult {
  return {
    requestedCount: 0,
    cachedCount: 0,
    downloadedCount: 0,
    failedCount: 0,
    complete: true,
    files: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prepareProductionRuntimeArtifacts).mockResolvedValue({
    modelId: MODEL_ID,
    revision: REVISION,
    status: 'prepared',
    processor: 'tokenizer',
    modelType: 'llama',
    observationMethod: 'transformers-runtime-artifact-preparation',
    error: undefined,
  });
  vi.mocked(prepareProductionModelCandidate).mockResolvedValue({ status: 'ready', prefetch: emptyPrefetch() });
});

describe('runProductionDownloadPreparation', () => {
  it('prepares runtime artifacts once, then downloads and accepts candidates in Production fallback order', async () => {
    vi.mocked(acceptDownloadedProductionCandidate).mockImplementation(async ({ candidate }) => ({
      modelId: MODEL_ID,
      resolvedRevision: REVISION,
      loaderRevisionOption: REVISION,
      candidate,
      status: candidate.dtype === 'q4f16' ? 'rejected' : 'accepted',
      observationMethod: 'production-cache-only-runtime-preparation',
      error: candidate.dtype === 'q4f16' ? { name: 'RuntimeError', message: 'q4f16 rejected' } : undefined,
    }));

    const result = await runProductionDownloadPreparation({ modelId: MODEL_ID, revision: REVISION });

    expect(result.status).toBe('accepted');
    expect(prepareProductionRuntimeArtifacts).toHaveBeenCalledTimes(1);
    expect(prepareProductionModelCandidate).toHaveBeenCalledTimes(2);
    expect(acceptDownloadedProductionCandidate).toHaveBeenCalledTimes(2);
    expect(acceptDownloadedProductionCandidate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      resolvedRevision: REVISION,
      loadRevision: REVISION,
      candidate: { device: 'webgpu', dtype: 'q4f16' },
    }));
    expect(acceptDownloadedProductionCandidate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      candidate: { device: 'webgpu', dtype: 'q4' },
    }));
  });

  it('stops before candidate acceptance when model artifact preparation fails', async () => {
    vi.mocked(prepareProductionModelCandidate).mockResolvedValue({
      status: 'failed',
      error: { name: 'ModelArtifactPrefetchError', message: 'stream disconnected before completion' },
      prefetch: undefined,
    });

    const result = await runProductionDownloadPreparation({ modelId: MODEL_ID, revision: REVISION });

    expect(result).toMatchObject({
      status: 'failed',
      failureStage: 'candidate-orchestration',
      candidates: {
        status: 'failed',
        error: { name: 'ModelArtifactPrefetchError' },
      },
    });
    expect(prepareProductionRuntimeArtifacts).toHaveBeenCalledTimes(1);
    expect(prepareProductionModelCandidate).toHaveBeenCalledTimes(1);
    expect(acceptDownloadedProductionCandidate).not.toHaveBeenCalled();
  });

  it('stops before model candidate preparation when runtime artifact preparation fails', async () => {
    vi.mocked(prepareProductionRuntimeArtifacts).mockResolvedValue({
      modelId: MODEL_ID,
      revision: REVISION,
      status: 'failed',
      processor: undefined,
      modelType: undefined,
      observationMethod: 'transformers-runtime-artifact-preparation',
      error: { name: 'RuntimeArtifactError', message: 'processor failed' },
    });

    const result = await runProductionDownloadPreparation({ modelId: MODEL_ID, revision: REVISION });

    expect(result).toMatchObject({
      status: 'failed',
      failureStage: 'runtime-artifacts',
      candidates: undefined,
    });
    expect(prepareProductionModelCandidate).not.toHaveBeenCalled();
    expect(acceptDownloadedProductionCandidate).not.toHaveBeenCalled();
  });

  it('reproduces the LFM2.5-230M q4f16-unavailable to q4 fallback without accepting the unavailable candidate', async () => {
    const modelId = 'LiquidAI/LFM2.5-230M-ONNX';
    const revision = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';
    vi.mocked(prepareProductionRuntimeArtifacts).mockResolvedValue({
      modelId,
      revision,
      status: 'prepared',
      processor: 'tokenizer',
      modelType: 'lfm2',
      observationMethod: 'transformers-runtime-artifact-preparation',
      error: undefined,
    });
    vi.mocked(prepareProductionModelCandidate).mockImplementation(async ({ candidate }) => (
      candidate.dtype === 'q4f16'
        ? { status: 'unavailable', reason: 'onnx/model_q4f16.onnx, onnx/model_q4f16.onnx_data', prefetch: emptyPrefetch() }
        : { status: 'ready', prefetch: emptyPrefetch() }
    ));
    vi.mocked(acceptDownloadedProductionCandidate).mockImplementation(async ({ candidate }) => ({
      modelId,
      resolvedRevision: revision,
      loaderRevisionOption: revision,
      candidate,
      status: 'accepted',
      observationMethod: 'production-cache-only-runtime-preparation',
      error: undefined,
    }));

    const result = await runProductionDownloadPreparation({ modelId, revision });

    expect(result.status).toBe('accepted');
    expect(result.candidates?.selectedCandidate).toEqual({ device: 'webgpu', dtype: 'q4' });
    expect(result.candidates?.attempts).toHaveLength(2);
    expect(result.candidates?.attempts[0]).toMatchObject({
      candidate: { device: 'webgpu', dtype: 'q4f16' },
      preparation: { status: 'unavailable' },
      acceptance: undefined,
    });
    expect(result.candidates?.attempts[1]).toMatchObject({
      candidate: { device: 'webgpu', dtype: 'q4' },
      preparation: { status: 'ready' },
      acceptance: { status: 'accepted' },
    });
    expect(acceptDownloadedProductionCandidate).toHaveBeenCalledTimes(1);
    expect(acceptDownloadedProductionCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidate: { device: 'webgpu', dtype: 'q4' },
    }));
  });

  it('injects repository-confirmed staged model paths into candidate download preparation', async () => {
    vi.mocked(acceptDownloadedProductionCandidate).mockImplementation(async ({ candidate }) => ({
      modelId: MODEL_ID,
      resolvedRevision: REVISION,
      loaderRevisionOption: REVISION,
      candidate,
      status: 'accepted',
      observationMethod: 'production-cache-only-runtime-preparation',
      error: undefined,
    }));

    await runProductionDownloadPreparation({
      modelId: MODEL_ID,
      revision: REVISION,
      candidateOrder: [{ device: 'webgpu', dtype: 'q4f16' }],
      requiredModelPathsByCandidate: {
        'webgpu/q4f16': [
          'onnx/decoder_model_merged_q4f16.onnx',
          'onnx/decoder_model_merged_q4f16.onnx_data',
          'onnx/vision_encoder_q4f16.onnx',
          'onnx/vision_encoder_q4f16.onnx_data',
        ],
      },
    });

    expect(prepareProductionModelCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidate: { device: 'webgpu', dtype: 'q4f16' },
      requiredModelPaths: [
        'onnx/decoder_model_merged_q4f16.onnx',
        'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx',
        'onnx/vision_encoder_q4f16.onnx_data',
      ],
    }));
  });

});
