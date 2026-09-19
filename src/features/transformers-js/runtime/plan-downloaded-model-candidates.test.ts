import { describe, expect, it, vi } from 'vitest';
import type { TransformersJsProductionInvestigationCandidate } from '@/features/transformers-js/types';
import {
  DownloadedModelResourcePlanningError,
  downloadedModelCandidatePlanError,
  planDownloadedModelCandidates,
} from '@/features/transformers-js/runtime/plan-downloaded-model-candidates';
import { ProductionResourceCandidateError } from './production-resource-plan';

const REVISION = '0123456789abcdef0123456789abcdef01234567';

describe('planDownloadedModelCandidates', () => {
  it('does not manufacture cache-miss evidence when no candidate can be planned', async () => {
    const match = vi.fn();
    const entries = await planDownloadedModelCandidates({
      modelId: 'org/model', revision: REVISION,
      candidates: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }],
      modelCache: { match },
      getModelFiles: async ({ candidate }) => {
        throw new ProductionResourceCandidateError({ candidate, cause: new Error('Invalid selected declaration') });
      },
      getRuntimeFiles: async () => ['tokenizer.json'],
      workerLocationUrl: 'https://naidan.example/worker.js',
    });
    expect(entries).toEqual([
      { status: 'planning-failed', candidate: { device: 'webgpu', dtype: 'q4f16' }, error: { name: 'ProductionResourceCandidateError', message: expect.any(String) } },
      { status: 'planning-failed', candidate: { device: 'webgpu', dtype: 'q4' }, error: { name: 'ProductionResourceCandidateError', message: expect.any(String) } },
    ]);
    expect(match).not.toHaveBeenCalled();
    const error = downloadedModelCandidatePlanError({ modelId: 'org/model', revision: REVISION, entries });
    expect(error).toBeInstanceOf(DownloadedModelResourcePlanningError);
    expect(error.message).not.toContain('MUST NOT fetch model artifacts');
    expect(error.message).not.toContain('incomplete');
  });

  it('propagates global selector incompatibility instead of trying another candidate', async () => {
    const globalFailure = new Error('Unsupported Transformers.js version');
    const getModelFiles = vi.fn(async () => {
      throw globalFailure;
    });
    const match = vi.fn();
    await expect(planDownloadedModelCandidates({
      modelId: 'org/model', revision: REVISION,
      candidates: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }],
      modelCache: { match }, getModelFiles, getRuntimeFiles: async () => [],
      workerLocationUrl: 'https://naidan.example/worker.js',
    })).rejects.toBe(globalFailure);
    expect(getModelFiles).toHaveBeenCalledOnce();
    expect(match).not.toHaveBeenCalled();
  });

  it('admits only complete resource-plan candidates without reading model bodies', async () => {
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
        status: 'checked',
        candidate: { device: 'webgpu', dtype: 'q4f16' },
        requiredModelPaths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
        missingModelPaths: ['onnx/model_q4f16.onnx_data'],
        requiredRuntimePaths: ['tokenizer_config.json', 'tokenizer.json'],
        missingRuntimePaths: [],
        complete: false,
      },
      {
        status: 'checked',
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
        status: 'checked',
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
