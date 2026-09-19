import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeProductionModelArtifactRequests } from '@/features/transformers-js/download-verification/logic/observe-production-model-artifact-requests';
import type { DownloadVerificationModelArtifactRequestObservation } from '@/features/transformers-js/download-verification/types';
import { createDownloadVerificationModelArtifactRequestWorkerClient, type DownloadVerificationModelArtifactRequestWorkerClient } from '@/features/transformers-js/download-verification/model-artifact-request-worker/client-hosted';

vi.mock('@/features/transformers-js/download-verification/model-artifact-request-worker/client-hosted', () => ({
  createDownloadVerificationModelArtifactRequestWorkerClient: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('observeProductionModelArtifactRequests', () => {
  it('uses a fresh observer worker for every production candidate in fallback order', async () => {
    const calls: Array<{ device: string; dtype: string }> = [];
    const disposals: number[] = [];
    let clientId = 0;
    vi.mocked(createDownloadVerificationModelArtifactRequestWorkerClient).mockImplementation(() => {
      const id = clientId++;
      return {
        async observeModelArtifactRequests({ modelId, revision, candidate }) {
          calls.push(candidate);
          return {
            modelId,
            revision,
            autoClass: 'AutoModelForCausalLM',
            candidate,
            status: 'observed',
            observationMethod: 'held-model-artifact-fetch-quiescence',
            quiescenceMs: 500,
            timeoutMs: 10_000,
            paths: [`onnx/model_${candidate.dtype}.onnx`],
            requests: [{
              path: `onnx/model_${candidate.dtype}.onnx`,
              url: `https://huggingface.co/${modelId}/resolve/${revision}/onnx/model_${candidate.dtype}.onnx`,
            }],
            error: undefined,
          };
        },
        async dispose() {
          disposals.push(id);
        },
      };
    });

    const observations = await observeProductionModelArtifactRequests({
      modelId: 'org/model',
      revision: '0123456789abcdef0123456789abcdef01234567',
    });

    expect(calls).toEqual([
      { device: 'webgpu', dtype: 'q4f16' },
      { device: 'webgpu', dtype: 'q4' },
      { device: 'wasm', dtype: 'q4' },
    ]);
    expect(disposals).toEqual([0, 1, 2]);
    expect(observations.map(observation => observation.paths[0])).toEqual([
      'onnx/model_q4f16.onnx',
      'onnx/model_q4.onnx',
      'onnx/model_q4.onnx',
    ]);
  });



  it('preserves a successful observation when dedicated worker disposal reports a remote release failure', async () => {
    vi.mocked(createDownloadVerificationModelArtifactRequestWorkerClient).mockReturnValue({
      observeModelArtifactRequests: vi.fn(async ({ modelId, revision, candidate }: Parameters<DownloadVerificationModelArtifactRequestWorkerClient['observeModelArtifactRequests']>[0]): Promise<DownloadVerificationModelArtifactRequestObservation> => ({
        modelId,
        revision,
        autoClass: 'AutoModelForCausalLM',
        candidate,
        status: 'observed',
        observationMethod: 'held-model-artifact-fetch-quiescence',
        quiescenceMs: 500,
        timeoutMs: 10_000,
        paths: ['onnx/model_q4f16.onnx'],
        requests: [{
          path: 'onnx/model_q4f16.onnx',
          url: `https://huggingface.co/${modelId}/resolve/${revision}/onnx/model_q4f16.onnx`,
        }],
        error: undefined,
      })),
      dispose: vi.fn(async () => {
        throw new Error('remote release failed');
      }),
    });

    const observation = await observeProductionModelArtifactRequests({
      modelId: 'org/model',
      revision: '0123456789abcdef0123456789abcdef01234567',
    });

    expect(observation).toHaveLength(3);
    expect(observation.every(item => item.status === 'observed')).toBe(true);
  });

  it('disposes the active observer worker when the caller aborts', async () => {
    const disposed = vi.fn(async () => {});
    vi.mocked(createDownloadVerificationModelArtifactRequestWorkerClient).mockReturnValue({
      observeModelArtifactRequests: vi.fn(async (): Promise<DownloadVerificationModelArtifactRequestObservation> => await new Promise(() => {})),
      dispose: disposed,
    });
    const controller = new AbortController();

    const observation = observeProductionModelArtifactRequests({
      modelId: 'org/model',
      revision: '0123456789abcdef0123456789abcdef01234567',
      signal: controller.signal,
    });
    controller.abort();

    await expect(observation).rejects.toMatchObject({ name: 'AbortError' });
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
