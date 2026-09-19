// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryFiles } from '@/features/transformers-js/replay-models/support/download-memory-files';
import type { ITransformersJsDownloadWorker } from '@/features/transformers-js/types';
import type { WorkerServerApi } from '@/utils/worker-transport';

const modelId = 'fixture/public-model';
const revision = 'a'.repeat(40);
const base = `https://huggingface.co/${modelId}/resolve/${revision}/`;
const cacheBase = `models/huggingface.co/${modelId}/resolve/${revision}/`;

it('keeps a runtime-version mismatch terminal instead of returning candidate planning failures', async () => {
  const h = await fixtureWorker();
  h.env.version = 'unreviewed-fixture-version';
  await expect(h.prepare()).rejects.toThrow('requires a reviewed runtime version');
  expect(h.tokenizer).not.toHaveBeenCalled();
  expect(h.processor).not.toHaveBeenCalled();
  expect(h.network).not.toHaveBeenCalled();
  expect(h.files.files.size).toBe(0);
});

it('keeps a valid first candidate when a later dtype has an invalid external chunk declaration', async () => {
  const h = await fixtureWorker();
  h.config.mockResolvedValue({ model_type: 'llama', 'transformers.js_config': { use_external_data_format: { 'model_q4f16.onnx': 1, 'model_q4.onnx': 101 } } });
  await expect(h.prepare()).resolves.toMatchObject({
    resourcePlansByCandidate: {
      'webgpu/q4f16': { status: 'ready', paths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'] },
      'webgpu/q4': { status: 'planning-failed' },
      'wasm/q4': { status: 'planning-failed' },
    },
  });
  expect(h.tokenizer).toHaveBeenCalledOnce();
  expect(h.network).not.toHaveBeenCalled();
});

async function fixtureWorker() {
  vi.resetModules();
  const files = createMemoryFiles();
  files.enter({ nextPhase: 'metadata', mutationPolicy: 'read-write' });
  const network = vi.fn<typeof fetch>(async () => new Response('{}', { headers: { 'Content-Length': '2' } }));
  const env = {
    version: '4.2.0',
    backends: { onnx: { wasm: {}, logLevel: 'error' } },
    fetch: network as typeof fetch,
    customCache: {
      match: async (_input: string | Request): Promise<Response | undefined> => undefined,
      put: async (_input: string | Request, _response: Response): Promise<void> => undefined,
    },
  };
  const config = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({ model_type: 'llama' }));
  const tokenizer = vi.fn(async () => ({}));
  const processor = vi.fn(async () => ({}));
  class SyntheticGenericModel {
    static async from_pretrained() {
      throw new Error('Metadata preparation must not construct a model');
    }
  }
  vi.doMock('@huggingface/transformers', () => ({
    env, AutoConfig: { from_pretrained: config }, AutoTokenizer: { from_pretrained: tokenizer },
    AutoProcessor: { from_pretrained: processor },
    ModelRegistry: { get_model_files: async () => ['onnx/model_q4.onnx'] },
    PreTrainedModel: SyntheticGenericModel,
    LlamaForCausalLM: SyntheticGenericModel,
  }));
  let api: WorkerServerApi<ITransformersJsDownloadWorker> | undefined;
  vi.doMock('@/utils/worker-transport', () => ({
    exposeWorkerRemote: ({ api: exposed }: { api: WorkerServerApi<ITransformersJsDownloadWorker> }) => {
      api = exposed;
    },
  }));
  vi.stubGlobal('self', { fetch: network, location: new URL('http://localhost/assets/download-worker.js') });
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('navigator', { userAgent: 'Vitest', vendor: '', hardwareConcurrency: 2, storage: { getDirectory: async () => files.root } });
  await import('./entry');
  if (api === undefined) throw new Error('Worker entry did not expose');
  return { api, env, network, files, config, tokenizer, processor, prepare: () => api!.prepareModelRuntimeArtifacts(modelId, revision, () => undefined) };
}

afterEach(() => {
  vi.doUnmock('@huggingface/transformers');
  vi.doUnmock('@/utils/worker-transport');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('canonicalizes only the known main Range probe and preserves Request/init precedence', async () => {
  const h = await fixtureWorker();
  const controller = new AbortController();
  h.tokenizer.mockImplementation(async () => {
    const request = new Request(`https://huggingface.co/${modelId}/resolve/main/tokenizer_config.json`, {
      headers: { Range: 'bytes=7-9', 'X-Fixture': 'original' }, signal: controller.signal,
    });
    const response = await h.env.fetch(request, { headers: { Range: 'bytes=0-0', 'X-Fixture': 'override' } });
    await response.body?.cancel();
    return {};
  });
  await h.prepare();
  expect(h.network).toHaveBeenCalledTimes(1);
  const [input, init] = h.network.mock.calls[0]!;
  const effective = new Request(input, init);
  expect(effective.url).toBe(`${base}tokenizer_config.json`);
  expect(effective.method).toBe('GET');
  expect(effective.headers.get('X-Fixture')).toBe('override');
  expect(effective.headers.get('Range')).toBe('bytes=0-0');
  controller.abort();
  expect(effective.signal.aborted).toBe(true);
  expect(h.files.files.size).toBe(0); // A successful presence probe is not a save obligation.
});

it('does not let an upstream catch turn a full main request into preparation success', async () => {
  const h = await fixtureWorker();
  h.tokenizer.mockImplementation(async () => {
    await h.env.fetch(`https://huggingface.co/${modelId}/resolve/main/tokenizer_config.json`).catch(() => undefined);
    return {};
  });
  await expect(h.prepare()).rejects.toThrow(/revision|identity/u);
  expect(h.network).not.toHaveBeenCalled();
});

it('permits an exact config size probe without persisting its partial response', async () => {
  const h = await fixtureWorker();
  h.network.mockResolvedValue(new Response(Uint8Array.of(123), {
    status: 206, headers: { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/200' },
  }));
  h.tokenizer.mockImplementation(async () => {
    const response = await h.env.fetch(`${base}config.json`, { headers: { Range: 'bytes=0-0' } });
    expect(response.status).toBe(206);
    await response.body?.cancel();
    return {};
  });
  await h.prepare();
  expect(h.network).toHaveBeenCalledOnce();
  expect(h.files.files.size).toBe(0);
});

it('does not broaden revisionless aliases to config size probes', async () => {
  const h = await fixtureWorker();
  h.tokenizer.mockImplementation(async () => {
    await h.env.fetch(`https://huggingface.co/${modelId}/resolve/main/config.json`, {
      headers: { Range: 'bytes=0-0' },
    }).catch(() => undefined);
    return {};
  });
  await expect(h.prepare()).rejects.toThrow('Unexpected metadata revision identity');
  expect(h.network).not.toHaveBeenCalled();
  expect(h.files.files.size).toBe(0);
});

it('permits a server to ignore an exact size Range without saving its probe response', async () => {
  const h = await fixtureWorker();
  h.tokenizer.mockImplementation(async () => {
    const response = await h.env.fetch(`${base}config.json`, { headers: { Range: 'bytes=0-0' } });
    expect(response.status).toBe(200);
    await response.body?.cancel();
    return {};
  });
  await h.prepare();
  expect(h.network).toHaveBeenCalledOnce();
  expect(h.files.files.size).toBe(0);
});

it('does not admit arbitrary partial metadata downloads as size probes', async () => {
  const h = await fixtureWorker();
  h.tokenizer.mockImplementation(async () => {
    await h.env.fetch(`${base}config.json`, { headers: { Range: 'bytes=1-2' } }).catch(() => undefined);
    return {};
  });
  await expect(h.prepare()).rejects.toThrow('Unexpected metadata Range request');
  expect(h.network).not.toHaveBeenCalled();
  expect(h.files.files.size).toBe(0);
});

it('latches synchronous transport failure even when the upstream consumer catches it', async () => {
  const h = await fixtureWorker();
  const primary = new Error('fixture synchronous transport failure');
  h.network.mockImplementation(() => {
    throw primary;
  });
  h.tokenizer.mockImplementation(async () => {
    await h.env.fetch(`${base}tokenizer.json`).catch(() => undefined);
    return {};
  });
  await expect(h.prepare()).rejects.toBe(primary);
});

it('preserves a swallowed writer failure after another attempted successful put', async () => {
  const h = await fixtureWorker();
  const primary = new DOMException('fixture metadata quota failure', 'QuotaExceededError');
  h.files.writerCloseErrors.set(`${cacheBase}tokenizer.json`, primary);
  h.tokenizer.mockImplementation(async () => {
    await h.env.customCache.put(`${base}tokenizer.json`, new Response('{}')).catch(() => undefined);
    await h.env.customCache.put(`${base}tokenizer_config.json`, new Response('{}')).catch(() => undefined);
    return {};
  });
  await expect(h.prepare()).rejects.toBe(primary);
  expect(h.files.files.has(`${cacheBase}.tokenizer.json.complete`)).toBe(false);
});

it('rejects a concurrent prefetch while metadata owns the runtime environment', async () => {
  const h = await fixtureWorker();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.config.mockImplementation(async () => {
    entered.resolve(); await release.promise; return { model_type: 'llama' };
  });
  const preparation = h.prepare();
  await entered.promise;
  try {
    await expect(h.api.prefetchUrls([`${base}onnx/model_q4.onnx`], () => undefined)).rejects.toThrow(/active|concurrent|busy/u);
    expect(h.network).not.toHaveBeenCalled();
  } finally {
    release.resolve(); await preparation;
  }
});

it('rejects concurrent metadata while a prefetch still owns a remote response', async () => {
  const h = await fixtureWorker();
  const response = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<void>();
  h.network.mockImplementation(async () => {
    entered.resolve(); return response.promise;
  });
  const prefetch = h.api.prefetchUrls([`${base}onnx/model_q4.onnx`], () => undefined);
  await entered.promise;
  try {
    await expect(h.prepare()).rejects.toThrow(/active|concurrent|busy/u);
    expect(h.config).not.toHaveBeenCalled();
  } finally {
    response.resolve(new Response(new Uint8Array([1, 2, 3]))); await prefetch;
  }
});

it('rejects a second metadata RPC without replacing the first operation environment', async () => {
  const h = await fixtureWorker();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  h.config.mockImplementation(async () => {
    entered.resolve(); await release.promise; return { model_type: 'llama' };
  });
  const preparation = h.prepare();
  await entered.promise;
  const firstCache = h.env.customCache;
  const firstFetch = h.env.fetch;
  try {
    await expect(h.prepare()).rejects.toThrow(/concurrent|busy/u);
    expect(h.env.customCache).toBe(firstCache);
    expect(h.env.fetch).toBe(firstFetch);
    expect(h.config).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve(); await preparation;
  }
});

it('retires the Worker after a cleanup deadline and does not permit a new prefetch', async () => {
  const h = await fixtureWorker();
  vi.useFakeTimers();
  h.network.mockResolvedValue(new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), { status: 404 }));
  h.tokenizer.mockImplementation(async () => {
    await h.env.fetch(`${base}processor_config.json`); return {};
  });
  let ready = false;
  const outcome = h.prepare().then(() => {
    ready = true; return undefined;
  }, error => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(ready).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await outcome).toMatchObject({ message: expect.stringContaining('cleanup deadline') });
  expect(ready).toBe(false);
  await expect(h.api.prefetchUrls([`${base}onnx/model_q4.onnx`], () => undefined)).rejects.toThrow(/terminal/u);
  expect(h.network).toHaveBeenCalledTimes(1);
});
