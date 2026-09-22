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
    configFromPretrained: vi.fn(),
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
  AutoConfig: {
    from_pretrained: transformerMocks.configFromPretrained,
  },
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
  // This unit controls request lifetime, not native metadata or model loading.
  // Give the new config-owned route the non-multimodal metadata it consumes.
  transformerMocks.configFromPretrained.mockResolvedValue({ model_type: 'lfm2' });
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
  it('keeps late dynamic env and self fetches held after the artifact deadline returns', async () => {
    const baseFetch = vi.mocked(self.fetch);
    const resume = Promise.withResolvers<void>();
    const issued = Promise.withResolvers<void>();
    const settled = vi.fn();
    transformerMocks.causalFromPretrained.mockImplementation(async () => {
      await resume.promise;
      const base = 'https://huggingface.co/org/model/resolve/main';
      void transformerMocks.env.fetch!(`${base}/onnx/model.onnx`).then(settled, settled);
      void self.fetch(`${base}/onnx/model.onnx_data`).then(settled, settled);
      void transformerMocks.env.fetch!(`${base}/config.json`).then(settled, settled);
      issued.resolve();
      return await new Promise(() => undefined);
    });
    await import('./entry');
    const api = exposedApis.at(-1) as ExposedObserver;
    const observation = api.observeModelArtifactRequests({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision: 'main',
      candidate: { device: 'webgpu', dtype: 'q4f16' },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(observation).resolves.toMatchObject({
      status: 'failed', paths: [],
      error: { message: 'Timed out while waiting for Transformers.js model artifact requests' },
    });
    resume.resolve();
    await issued.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(baseFetch).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps dynamic and captured fetches inert after returning a quiescent artifact snapshot', async () => {
    const baseFetch = vi.mocked(self.fetch);
    const resume = Promise.withResolvers<void>();
    const issued = Promise.withResolvers<void>();
    const settled = vi.fn();
    transformerMocks.causalFromPretrained.mockImplementation(async () => {
      const capturedEnvFetch = transformerMocks.env.fetch!;
      const capturedSelfFetch = self.fetch;
      const base = 'https://huggingface.co/org/model/resolve/main';
      void capturedEnvFetch(`${base}/onnx/model.onnx`).then(settled, settled);
      await resume.promise;
      void transformerMocks.env.fetch!(`${base}/onnx/late.onnx`).then(settled, settled);
      void self.fetch(`${base}/onnx/late.onnx_data`).then(settled, settled);
      void capturedEnvFetch(`${base}/onnx/captured.onnx`).then(settled, settled);
      void capturedSelfFetch(`${base}/config.json`).then(settled, settled);
      issued.resolve();
      return await new Promise(() => undefined);
    });
    await import('./entry');
    const api = exposedApis.at(-1) as ExposedObserver;
    const observation = api.observeModelArtifactRequests({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision: 'main',
      candidate: { device: 'webgpu', dtype: 'q4f16' },
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await observation;
    expect(result).toMatchObject({ status: 'observed', paths: ['onnx/model.onnx'] });
    const snapshot = structuredClone(result);
    resume.resolve();
    await issued.promise;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(baseFetch).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(result).toEqual(snapshot);
  });

  it('returns an observed result without rejecting held real-model fetches to unwind the load', async () => {
    const baseFetch = vi.mocked(self.fetch);
    baseFetch.mockResolvedValue(new Response(JSON.stringify({ model_type: 'lfm2' })));
    transformerMocks.configFromPretrained.mockImplementation(async () => {
      const response = await transformerMocks.env.fetch!('https://huggingface.co/org/model/resolve/main/config.json');
      return await response.json();
    });
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
      autoClass: 'AutoModelForCausalLM',
      paths: [
        'onnx/model_q4f16.onnx',
        'onnx/model_q4f16.onnx_data',
      ],
    }));
    expect(transformerMocks.configFromPretrained).toHaveBeenCalledExactlyOnceWith(
      'LiquidAI/LFM2.5-230M-ONNX', { revision: 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d' },
    );
    expect(transformerMocks.causalFromPretrained).toHaveBeenCalledExactlyOnceWith(
      'LiquidAI/LFM2.5-230M-ONNX', { revision: 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d', device: 'webgpu', dtype: 'q4f16', silent: true },
    );
    expect(transformerMocks.imageTextFromPretrained).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledExactlyOnceWith(
      'https://huggingface.co/org/model/resolve/main/config.json',
      { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' },
    );
  });

  it('refuses concurrent and retired RPCs without reopening or replacing the first observation', async () => {
    await import('./entry');
    const api = exposedApis.at(-1) as ExposedObserver;
    const args = {
      modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision: 'main',
      candidate: { device: 'webgpu', dtype: 'q4f16' },
    } as const;
    const first = api.observeModelArtifactRequests(args);
    const guardedFetch = self.fetch;
    await expect(api.observeModelArtifactRequests(args)).rejects.toThrow('can only be used once');
    await vi.advanceTimersByTimeAsync(500);
    await expect(first).resolves.toMatchObject({
      status: 'observed', paths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
    });
    await expect(api.observeModelArtifactRequests(args)).rejects.toThrow('can only be used once');
    expect(transformerMocks.configFromPretrained).toHaveBeenCalledTimes(1);
    expect(transformerMocks.causalFromPretrained).toHaveBeenCalledTimes(1);
    expect(self.fetch).toBe(guardedFetch);
    expect(transformerMocks.env.fetch).toBe(guardedFetch);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires the gate when metadata times out before model loading begins', async () => {
    const baseFetch = vi.mocked(self.fetch);
    const resume = Promise.withResolvers<void>();
    const issued = Promise.withResolvers<void>();
    const settled = vi.fn();
    transformerMocks.configFromPretrained.mockImplementation(async () => {
      await resume.promise;
      void transformerMocks.env.fetch!('https://huggingface.co/org/model/resolve/main/config.json').then(settled, settled);
      issued.resolve();
      return { model_type: 'lfm2' };
    });
    await import('./entry');
    const api = exposedApis.at(-1) as ExposedObserver;
    const observation = api.observeModelArtifactRequests({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision: 'main',
      candidate: { device: 'webgpu', dtype: 'q4f16' },
    });
    const rejected = expect(observation).rejects.toThrow('Timed out while reading model configuration');
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    resume.resolve();
    await issued.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(baseFetch).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(transformerMocks.causalFromPretrained).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a metadata rejection while keeping the failed worker closed', async () => {
    const baseFetch = vi.mocked(self.fetch);
    const error = new Error('controlled metadata failure');
    transformerMocks.configFromPretrained.mockRejectedValue(error);
    await import('./entry');
    const api = exposedApis.at(-1) as ExposedObserver;
    await expect(api.observeModelArtifactRequests({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision: 'main',
      candidate: { device: 'webgpu', dtype: 'q4f16' },
    })).rejects.toBe(error);
    const settled = vi.fn();
    void self.fetch('https://huggingface.co/org/model/resolve/main/config.json').then(settled, settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(baseFetch).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(transformerMocks.causalFromPretrained).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a failed model outcome without restoring runtime fetch', async () => {
    const baseFetch = vi.mocked(self.fetch);
    transformerMocks.causalFromPretrained.mockRejectedValue(new RangeError('controlled model failure'));
    await import('./entry');
    const api = exposedApis.at(-1) as ExposedObserver;
    await expect(api.observeModelArtifactRequests({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision: 'main',
      candidate: { device: 'webgpu', dtype: 'q4f16' },
    })).resolves.toMatchObject({ status: 'failed', paths: [], error: { name: 'RangeError', message: 'controlled model failure' } });
    const settled = vi.fn();
    void transformerMocks.env.fetch!('https://huggingface.co/org/model/resolve/main/onnx/model.onnx').then(settled, settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(baseFetch).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the unexpected successful model load failure outcome and retires its gate', async () => {
    const baseFetch = vi.mocked(self.fetch);
    transformerMocks.causalFromPretrained.mockResolvedValue({});
    await import('./entry');
    const api = exposedApis.at(-1) as ExposedObserver;
    await expect(api.observeModelArtifactRequests({
      modelId: 'LiquidAI/LFM2.5-230M-ONNX', revision: 'main',
      candidate: { device: 'webgpu', dtype: 'q4f16' },
    })).resolves.toMatchObject({ status: 'failed', paths: [], error: { name: 'UnexpectedModelLoad' } });
    const settled = vi.fn();
    void self.fetch('https://huggingface.co/org/model/resolve/main/config.json').then(settled, settled);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(baseFetch).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
