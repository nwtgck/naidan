import { describe, expect, it, vi } from 'vitest';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';
import {
  downloadedModelCandidatePlanError,
  planDownloadedModelCandidates,
} from '@/features/transformers-js/runtime/plan-downloaded-model-candidates';

const REVISION = '0123456789abcdef0123456789abcdef01234567';

describe('planDownloadedModelCandidates', () => {
  it('admits only complete ModelRegistry candidates without reading model bodies', async () => {
    const cancel = vi.fn(async () => {});
    const match = vi.fn(async (request: string | Request) => {
      const url = typeof request === 'string' ? request : request.url;
      if (url.endsWith('/onnx/model_q4f16.onnx_data')) return undefined;
      return { body: { cancel } } as unknown as Response;
    });

    const entries = await planDownloadedModelCandidates({
      modelId: 'org/model',
      revision: REVISION,
      candidates: [
        { device: 'webgpu', dtype: 'q4f16' },
        { device: 'webgpu', dtype: 'q4' },
      ],
      modelCache: { match },
      getModelFiles: vi.fn(async ({ candidate }: {
        candidate: TransformersJsProductionInvestigationCandidate;
      }) => [
        'config.json',
        `onnx/model_${candidate.dtype}.onnx`,
        `onnx/model_${candidate.dtype}.onnx_data`,
        'generation_config.json',
      ]),
      getRuntimeFiles: async () => ['tokenizer_config.json', 'tokenizer.json'],
      workerLocationUrl: 'https://naidan.example/assets/worker.js',
    });

    expect(entries).toEqual([
      {
        candidate: { device: 'webgpu', dtype: 'q4f16' },
        requiredModelPaths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
        missingModelPaths: ['onnx/model_q4f16.onnx_data'],
        requiredRuntimePaths: ['tokenizer_config.json', 'tokenizer.json'],
        missingRuntimePaths: [],
        complete: false,
      },
      {
        candidate: { device: 'webgpu', dtype: 'q4' },
        requiredModelPaths: ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'],
        missingModelPaths: [],
        requiredRuntimePaths: ['tokenizer_config.json', 'tokenizer.json'],
        missingRuntimePaths: [],
        complete: true,
      },
    ]);
    expect(match).toHaveBeenCalledWith(
      `https://huggingface.co/org/model/resolve/${REVISION}/onnx/model_q4.onnx_data`,
    );
    expect(cancel).toHaveBeenCalledTimes(5);
  });

  it('deduplicates shared artifacts across candidate checks', async () => {
    const match = vi.fn(async () => new Response(new Uint8Array([1])));
    await planDownloadedModelCandidates({
      modelId: 'org/model',
      revision: REVISION,
      candidates: [
        { device: 'webgpu', dtype: 'q4' },
        { device: 'wasm', dtype: 'q4' },
      ],
      modelCache: { match },
      getModelFiles: async () => ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'],
      getRuntimeFiles: async () => [],
      workerLocationUrl: 'https://naidan.example/worker.js',
    });
    expect(match).toHaveBeenCalledTimes(2);
  });

  it('reports every incomplete candidate as a terminal offline-load error', () => {
    const error = downloadedModelCandidatePlanError({
      modelId: 'org/model',
      revision: REVISION,
      entries: [{
        candidate: { device: 'webgpu', dtype: 'q4f16' },
        requiredModelPaths: ['onnx/model_q4f16.onnx'],
        missingModelPaths: ['onnx/model_q4f16.onnx'],
        requiredRuntimePaths: [],
        missingRuntimePaths: [],
        complete: false,
      }],
    });
    expect(error.message).toContain('offline Load will not download or repair files');
    expect(error.message).toContain('webgpu/q4f16: onnx/model_q4f16.onnx');
  });
});
