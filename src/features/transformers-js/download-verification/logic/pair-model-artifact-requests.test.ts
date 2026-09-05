import { describe, expect, it } from 'vitest';
import { pairModelArtifactRequests } from '@/features/transformers-js/download-verification/logic/pair-model-artifact-requests';
import type { DownloadVerificationModelArtifactRequestObservation } from '@/features/transformers-js/download-verification/types';

function observation({
  revision,
  paths,
  status = 'observed',
}: {
  revision: string;
  paths: string[];
  status?: DownloadVerificationModelArtifactRequestObservation['status'];
}): DownloadVerificationModelArtifactRequestObservation {
  return {
    modelId: 'org/model',
    revision,
    autoClass: 'AutoModelForCausalLM',
    candidate: { device: 'webgpu', dtype: 'q4f16' },
    status,
    observationMethod: 'held-model-artifact-fetch-quiescence',
    quiescenceMs: 500,
    timeoutMs: 10_000,
    paths,
    requests: paths.map(path => ({
      path,
      url: `https://huggingface.co/org/model/resolve/${revision}/${path}`,
    })),
    error: status === 'observed' ? undefined : { name: 'Error', message: 'observation failed' },
  };
}

describe('pairModelArtifactRequests', () => {
  it('pairs an immutable fetch URL with the TJS-generated Production main cache URL by path', () => {
    const sha = 'a'.repeat(40);
    const result = pairModelArtifactRequests({
      immutableObservation: observation({
        revision: sha,
        paths: ['onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx'],
      }),
      cacheIdentityObservation: observation({
        revision: 'main',
        paths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
      }),
    });

    expect(result).toEqual({
      status: 'paired',
      modelId: 'org/model',
      autoClass: 'AutoModelForCausalLM',
      candidate: { device: 'webgpu', dtype: 'q4f16' },
      fetchRevision: sha,
      cacheRevision: 'main',
      requests: [
        {
          path: 'onnx/model_q4f16.onnx',
          fetchUrl: `https://huggingface.co/org/model/resolve/${sha}/onnx/model_q4f16.onnx`,
          cacheUrl: 'https://huggingface.co/org/model/resolve/main/onnx/model_q4f16.onnx',
        },
        {
          path: 'onnx/model_q4f16.onnx_data',
          fetchUrl: `https://huggingface.co/org/model/resolve/${sha}/onnx/model_q4f16.onnx_data`,
          cacheUrl: 'https://huggingface.co/org/model/resolve/main/onnx/model_q4f16.onnx_data',
        },
      ],
    });
  });

  it('fails closed when main and the resolved SHA produce different artifact path sets', () => {
    const result = pairModelArtifactRequests({
      immutableObservation: observation({
        revision: 'a'.repeat(40),
        paths: ['onnx/decoder_q4f16.onnx'],
      }),
      cacheIdentityObservation: observation({
        revision: 'main',
        paths: ['onnx/decoder_q4f16.onnx', 'onnx/vision_q4f16.onnx'],
      }),
    });

    expect(result).toEqual({
      status: 'failed',
      reason: 'Immutable revision and Production cache revision resolved different model artifact paths',
    });
  });

  it('does not pair paths from a failed observer run', () => {
    const result = pairModelArtifactRequests({
      immutableObservation: observation({ revision: 'a'.repeat(40), paths: [], status: 'failed' }),
      cacheIdentityObservation: observation({ revision: 'main', paths: [] }),
    });

    expect(result).toEqual({
      status: 'failed',
      reason: 'Immutable-revision model artifact observation failed',
    });
  });
});
