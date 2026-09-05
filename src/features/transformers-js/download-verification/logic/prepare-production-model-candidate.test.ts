import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareProductionModelCandidate } from '@/features/transformers-js/download-verification/logic/prepare-production-model-candidate';
import { observeProductionModelArtifactCandidateRequests } from '@/features/transformers-js/download-verification/logic/observe-production-model-artifact-requests';
import { createTransformersJsWorkerClient } from '@/features/transformers-js/worker/client';
import type {
  DownloadVerificationModelArtifactRequestObservation,
} from '@/features/transformers-js/download-verification/types';
import type {
  TransformersJsPrefetchFileResult,
  TransformersJsPrefetchResult,
  TransformersJsProductionInvestigationCandidate,
} from '@/features/transformers-js/types';

vi.mock('@/features/transformers-js/download-verification/logic/observe-production-model-artifact-requests', () => ({
  observeProductionModelArtifactCandidateRequests: vi.fn(),
}));
vi.mock('@/features/transformers-js/worker/client', () => ({
  createTransformersJsWorkerClient: vi.fn(),
}));

const MODEL_ID = 'org/model';
const REVISION = '0123456789abcdef0123456789abcdef01234567';
const CANDIDATE: TransformersJsProductionInvestigationCandidate = { device: 'webgpu', dtype: 'q4f16' };

function observed(): DownloadVerificationModelArtifactRequestObservation {
  return {
    modelId: MODEL_ID,
    revision: REVISION,
    autoClass: 'AutoModelForCausalLM',
    candidate: CANDIDATE,
    status: 'observed',
    observationMethod: 'held-model-artifact-fetch-quiescence',
    quiescenceMs: 500,
    timeoutMs: 10_000,
    paths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
    requests: [
      {
        path: 'onnx/model_q4f16.onnx',
        url: `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/onnx/model_q4f16.onnx`,
      },
      {
        path: 'onnx/model_q4f16.onnx_data',
        url: `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/onnx/model_q4f16.onnx_data`,
      },
    ],
    error: undefined,
  };
}

function successfulFile({ path }: { path: string }): TransformersJsPrefetchFileResult {
  return {
    status: 'downloaded',
    url: `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/${path}`,
    path: `models/huggingface.co/${MODEL_ID}/resolve/${REVISION}/${path}`,
    byteLength: 1024,
    expectedByteLength: 1024,
  };
}

function result({ files }: { files: TransformersJsPrefetchFileResult[] }): TransformersJsPrefetchResult {
  const failedCount = files.filter(file => file.status === 'failed').length;
  const downloadedCount = files.filter(file => file.status === 'downloaded').length;
  const cachedCount = files.filter(file => file.status === 'cached').length;
  return {
    requestedCount: files.length,
    cachedCount,
    downloadedCount,
    failedCount,
    complete: failedCount === 0,
    files,
  };
}

function failedFile({ path, status, message }: { path: string; status: number; message: string }): TransformersJsPrefetchFileResult {
  return {
    status: 'failed',
    url: `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/${path}`,
    path: `models/huggingface.co/${MODEL_ID}/resolve/${REVISION}/${path}`,
    failureStage: 'response-status',
    httpStatus: status,
    error: { name: 'Error', message },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(observeProductionModelArtifactCandidateRequests).mockResolvedValue(observed());
});

describe('prepareProductionModelCandidate', () => {
  it('prefetches only the exact URLs emitted by the actual Transformers.js loader', async () => {
    const dispose = vi.fn(async () => {});
    const prefetchUrls = vi.fn(async ({ urls }: { urls: string[] }) => result({
      files: urls.map(url => successfulFile({ path: new URL(url).pathname.split(`/resolve/${REVISION}/`)[1]! })),
    }));
    vi.mocked(createTransformersJsWorkerClient).mockReturnValue({
      prefetchUrls,
      dispose,
    } as unknown as ReturnType<typeof createTransformersJsWorkerClient>);

    await expect(prepareProductionModelCandidate({
      modelId: MODEL_ID,
      revision: REVISION,
      candidate: CANDIDATE,
    })).resolves.toMatchObject({
      status: 'ready',
      prefetch: { requestedCount: 2, downloadedCount: 2, failedCount: 0, complete: true },
    });

    expect(prefetchUrls).toHaveBeenCalledWith({
      urls: observed().requests.map(request => request.url),
      progressCallback: expect.any(Function),
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('adds repository-confirmed staged model files that held-fetch observation cannot reach yet', async () => {
    const dispose = vi.fn(async () => {});
    const prefetchUrls = vi.fn(async ({ urls }: { urls: string[] }) => result({
      files: urls.map(url => successfulFile({ path: new URL(url).pathname.split(`/resolve/${REVISION}/`)[1]! })),
    }));
    vi.mocked(createTransformersJsWorkerClient).mockReturnValue({
      prefetchUrls,
      dispose,
    } as unknown as ReturnType<typeof createTransformersJsWorkerClient>);

    await expect(prepareProductionModelCandidate({
      modelId: MODEL_ID,
      revision: REVISION,
      candidate: CANDIDATE,
      requiredModelPaths: [
        'onnx/model_q4f16.onnx',
        'onnx/model_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx',
        'onnx/vision_encoder_q4f16.onnx_data',
      ],
    })).resolves.toMatchObject({
      status: 'ready',
      prefetch: { requestedCount: 4, downloadedCount: 4, failedCount: 0, complete: true },
    });

    expect(prefetchUrls).toHaveBeenCalledWith({
      urls: [
        `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/onnx/model_q4f16.onnx`,
        `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/onnx/model_q4f16.onnx_data`,
        `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/onnx/vision_encoder_q4f16.onnx`,
        `https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/onnx/vision_encoder_q4f16.onnx_data`,
      ],
      progressCallback: expect.any(Function),
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('classifies a missing required repository artifact as candidate unavailability', async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(createTransformersJsWorkerClient).mockReturnValue({
      prefetchUrls: vi.fn(async () => result({
        files: [
          successfulFile({ path: 'onnx/model_q4f16.onnx' }),
          failedFile({ path: 'onnx/model_q4f16.onnx_data', status: 404, message: 'HTTP 404' }),
        ],
      })),
      dispose,
    } as unknown as ReturnType<typeof createTransformersJsWorkerClient>);

    const preparation = await prepareProductionModelCandidate({ modelId: MODEL_ID, revision: REVISION, candidate: CANDIDATE });

    expect(preparation.status).toBe('unavailable');
    if (preparation.status === 'unavailable') {
      expect(preparation.reason).toContain(`models/huggingface.co/${MODEL_ID}/resolve/${REVISION}/onnx/model_q4f16.onnx_data`);
      expect(preparation.prefetch.files).toContainEqual(expect.objectContaining({
        status: 'failed',
        failureStage: 'response-status',
        httpStatus: 404,
      }));
    }
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not turn network or server failures into candidate unavailability', async () => {
    const dispose = vi.fn(async () => {});
    vi.mocked(createTransformersJsWorkerClient).mockReturnValue({
      prefetchUrls: vi.fn(async () => result({
        files: [failedFile({
          path: 'onnx/model_q4f16.onnx',
          status: 503,
          message: `HTTP 503 at https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/onnx/model_q4f16.onnx?token=secret`,
        })],
      })),
      dispose,
    } as unknown as ReturnType<typeof createTransformersJsWorkerClient>);

    const preparation = await prepareProductionModelCandidate({ modelId: MODEL_ID, revision: REVISION, candidate: CANDIDATE });

    expect(preparation).toMatchObject({
      status: 'failed',
      error: {
        name: 'Error',
        message: `HTTP 503 at https://huggingface.co/${MODEL_ID}/resolve/${REVISION}/onnx/model_q4f16.onnx`,
      },
    });
    if (preparation.status === 'failed') {
      expect(preparation.error.message).not.toContain('secret');
      expect(preparation.prefetch?.files).toContainEqual(expect.objectContaining({
        status: 'failed',
        failureStage: 'response-status',
        httpStatus: 503,
      }));
    }
  });

  it('fails closed when observed artifact URLs do not belong to the requested immutable revision', async () => {
    vi.mocked(observeProductionModelArtifactCandidateRequests).mockResolvedValue({
      ...observed(),
      requests: [{
        path: 'onnx/model_q4f16.onnx',
        url: `https://huggingface.co/${MODEL_ID}/resolve/main/onnx/model_q4f16.onnx`,
      }],
    });

    const preparation = await prepareProductionModelCandidate({ modelId: MODEL_ID, revision: REVISION, candidate: CANDIDATE });

    expect(preparation).toMatchObject({
      status: 'failed',
      error: { name: 'ModelArtifactRequestIdentityMismatch' },
      prefetch: undefined,
    });
    expect(createTransformersJsWorkerClient).not.toHaveBeenCalled();
  });

  it('stops before prefetch when the actual-loader request observation fails', async () => {
    vi.mocked(observeProductionModelArtifactCandidateRequests).mockResolvedValue({
      ...observed(),
      status: 'failed',
      paths: [],
      requests: [],
      error: { name: 'ObserverError', message: 'could not observe requests' },
    });

    const preparation = await prepareProductionModelCandidate({ modelId: MODEL_ID, revision: REVISION, candidate: CANDIDATE });

    expect(preparation).toEqual({
      status: 'failed',
      error: { name: 'ObserverError', message: 'could not observe requests' },
      prefetch: undefined,
    });
    expect(createTransformersJsWorkerClient).not.toHaveBeenCalled();
  });
});
