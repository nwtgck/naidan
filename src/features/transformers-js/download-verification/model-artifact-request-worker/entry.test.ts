import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exposedApis = vi.hoisted(() => [] as unknown[]);
const transformerMocks = vi.hoisted(() => {
  const env = {
    backends: {
      onnx: {
        wasm: {},
      },
    },
    allowLocalModels: false,
    allowRemoteModels: true,
    useBrowserCache: false,
    useCustomCache: false,
    useWasmCache: false,
    fetch: undefined as typeof fetch | undefined,
  };
  return {
    env,
    causalFromPretrained: vi.fn(),
    imageTextFromPretrained: vi.fn(),
  };
});

vi.mock('comlink', () => ({
  expose: vi.fn((api: unknown) => {
    exposedApis.push(api);
  }),
}));

vi.mock('@huggingface/transformers', () => ({
  AutoModelForCausalLM: {
    from_pretrained: transformerMocks.causalFromPretrained,
  },
  AutoModelForImageTextToText: {
    from_pretrained: transformerMocks.imageTextFromPretrained,
  },
  env: transformerMocks.env,
}));

interface ExposedObserver {
  observeModelArtifactRequests(args: {
    modelId: string,
    revision: string,
    candidate: { device: 'webgpu'; dtype: 'q4f16' };
  }): Promise<{
    status: string;
    paths: string[];
  }>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  exposedApis.length = 0;

  const baseFetch = vi.fn(async () => new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', baseFetch);
  vi.stubGlobal('self', {
    fetch: baseFetch,
    location: {
      origin: 'http://localhost:3000',
      href: 'http://localhost:3000/src/features/transformers-js/download-verification/model-artifact-request-worker/entry.ts',
    },
  });
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0',
    vendor: 'Google Inc.',
    hardwareConcurrency: 8,
  });

  transformerMocks.env.fetch = undefined;
  transformerMocks.causalFromPretrained.mockImplementation(async (_modelId: string, options: { revision: string }) => {
    const runtimeFetch = transformerMocks.env.fetch;
    if (runtimeFetch === undefined) throw new Error('worker did not configure Transformers.js fetch');

    const base = `https://huggingface.co/LiquidAI/LFM2.5-230M-ONNX/resolve/${options.revision}/onnx`;
    const core = runtimeFetch(`${base}/model_q4f16.onnx`);
    const externalData = runtimeFetch(`${base}/model_q4f16.onnx_data`);

    // Model the real TJS web bundle's parallel request shape. This branch is not
    // part of the Promise returned by from_pretrained(), so synthetically rejecting
    // all held fetches can surface as an unhandled rejection.
    void externalData.then(response => response.arrayBuffer());
    await core;
    return {};
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('model artifact request worker', () => {
  it('returns an observed result without rejecting held real-model fetches to unwind the load', async () => {
    await import('./entry');
    const api = exposedApis.at(-1) as ExposedObserver;
    const observation = api.observeModelArtifactRequests({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX',
      revision: 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d',
      candidate: { device: 'webgpu', dtype: 'q4f16' },
    });

    await vi.advanceTimersByTimeAsync(500);

    await expect(observation).resolves.toEqual(expect.objectContaining({
      status: 'observed',
      paths: [
        'onnx/model_q4f16.onnx',
        'onnx/model_q4f16.onnx_data',
      ],
    }));
  });
});
