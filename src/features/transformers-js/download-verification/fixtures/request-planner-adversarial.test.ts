import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createModelArtifactRequestBarrier } from '@/features/transformers-js/download-verification/model-artifact-request-worker/request-barrier';

type Options = {
  config: Record<string, unknown>;
  revision: string;
  device: 'webgpu';
  dtype: 'q4f16' | 'q4';
  local_files_only: true;
  progress_callback?: () => void;
};
interface WebModule {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    useBrowserCache: boolean;
    useCustomCache: boolean;
    useWasmCache: boolean;
    fetch: typeof fetch;
    customCache: {
      match(request: string): Promise<Response | undefined>;
      put(): Promise<void>;
    };
  };
  AutoModelForCausalLM: { from_pretrained(id: string, options: Options): Promise<unknown> };
  AutoModelForImageTextToText: WebModule['AutoModelForCausalLM'];
  ModelRegistry: {
    get_model_files(id: string, options: Options): Promise<string[]>;
    get_file_metadata(id: string, path: string, options: { revision: string }): Promise<{ exists: boolean; fromCache: boolean }>;
  };
}

const REVISION = 'a'.repeat(40);
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

// Reconstruct only the planning fields captured in repository evidence. These
// are not full exported configs and cannot establish real ONNX load success.
function configFromEvidence({ name }: { name: string }): Record<string, unknown> {
  const fixture = JSON.parse(readFileSync(resolve(
    process.cwd(), `src/features/transformers-js/download-verification/fixtures/repositories/${name}.json`,
  ), 'utf8')) as { modelType: string; architectures: string[]; transformersJsConfig: Record<string, unknown> };
  return {
    model_type: fixture.modelType,
    architectures: fixture.architectures,
    'transformers.js_config': fixture.transformersJsConfig,
    text_config: { model_type: 'llama', num_hidden_layers: 1, num_attention_heads: 1, hidden_size: 8 },
  };
}

async function harness({ config, progress }: { config: Record<string, unknown>; progress: 'enabled' | 'disabled' }) {
  const forbiddenFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('External fetch forbidden in planner test');
  });
  vi.stubGlobal('fetch', forbiddenFetch);
  // Each test gets fresh upstream in-flight maps, like a dedicated Worker.
  const url = pathToFileURL(resolve(process.cwd(), 'node_modules/@huggingface/transformers/dist/transformers.web.js'));
  // require.resolve selects the CJS export; the native web bundle imports the
  // ESM bundle in this pinned ORT package. Spy on that exact class identity.
  const ortUrl = pathToFileURL(resolve(dirname(createRequire(url).resolve('onnxruntime-web/webgpu')), 'ort.webgpu.bundle.min.mjs')).href;
  const ort = await import(/* @vite-ignore */ ortUrl) as {
    InferenceSession: { create(...args: unknown[]): Promise<unknown> };
  };
  const sessionCreate = vi.spyOn(ort.InferenceSession, 'create').mockImplementation(async () => ({ release: async () => undefined }));
  cleanups.push(() => sessionCreate.mockRestore());
  url.searchParams.set('planner-test', crypto.randomUUID());
  // The web bundle imported natively in Node otherwise selects its empty
  // onnxruntime-node shim. Select the browser branch while preserving Vitest's
  // process services; this does not emulate actual WebGPU execution.
  const originalProcess = globalThis.process;
  vi.stubGlobal('process', { ...originalProcess, release: { ...originalProcess.release, name: 'browser-test' } });
  const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} });
  cleanups.push(() => {
    if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
    else Reflect.deleteProperty(navigator, 'gpu');
  });
  let runtime: WebModule;
  try {
    runtime = await import(/* @vite-ignore */ url.href) as WebModule;
  } finally {
    vi.stubGlobal('process', originalProcess);
  }
  Object.assign(runtime.env, {
    allowLocalModels: true, allowRemoteModels: false, useBrowserCache: false,
    useCustomCache: true, useWasmCache: false, fetch: forbiddenFetch,
  });
  const release = Promise.withResolvers<void>();
  const requests: string[] = [];
  const bodyReads = vi.fn();
  runtime.env.customCache = {
    async match(request) {
      requests.push(request);
      if (!request.includes('/onnx/')) return new Response('{}');
      await release.promise;
      // Tiny synthetic bodies let the real loader reach an instrumented ORT
      // boundary. They never claim to be valid ONNX or real model weights.
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          bodyReads();
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
      }, { highWaterMark: 0 }), { headers: { 'Content-Length': '1' } });
    },
    async put() {
      throw new Error('Planner must not write cache');
    },
  };
  const options: Options = {
    config, revision: REVISION, device: 'webgpu', dtype: 'q4f16', local_files_only: true,
    ...(progress === 'enabled' ? { progress_callback: () => undefined } : {}),
  };
  const artifactPaths = () => [...new Set(requests.filter(path => path.includes('/onnx/'))
    .map(path => `onnx/${path.split('/onnx/')[1]}`))].sort();
  return { runtime, requests, options, release, artifactPaths, sessionCreate, bodyReads, forbiddenFetch };
}

describe('actual web bundle request planner adversarial investigation', () => {
  it.each([
    { fixture: 'qwen3-5-2b', autoClass: 'AutoModelForCausalLM' as const, sessions: ['decoder_model_merged', 'embed_tokens'], extraPaths: [] },
    { fixture: 'qwen3-5-4b', autoClass: 'AutoModelForCausalLM' as const, sessions: ['decoder_model_merged', 'embed_tokens'], extraPaths: ['onnx/decoder_model_merged_q4f16.onnx_data_1'] },
    { fixture: 'gemma-4-e2b-it', autoClass: 'AutoModelForImageTextToText' as const, sessions: ['audio_encoder', 'decoder_model_merged', 'embed_tokens', 'vision_encoder'], extraPaths: [] },
  ])('holds every observed $fixture artifact before bytes or ORT, then compares with a completed instrumented load', async ({ fixture, autoClass, sessions, extraPaths }) => {
    const h = await harness({ config: configFromEvidence({ name: fixture }), progress: 'disabled' });
    const load = h.runtime[autoClass].from_pretrained('fixture/model', h.options);
    const expected = [...sessions.flatMap(name => [`onnx/${name}_q4f16.onnx`, `onnx/${name}_q4f16.onnx_data`]), ...extraPaths].sort();
    await vi.waitFor(() => expect(h.artifactPaths()).toEqual(expected));
    expect(h.bodyReads).not.toHaveBeenCalled();
    expect(h.sessionCreate).not.toHaveBeenCalled();
    h.release.resolve();
    await load;
    expect(h.artifactPaths()).toEqual(expected);
    expect(h.sessionCreate).toHaveBeenCalledTimes(sessions.length);
    expect(h.forbiddenFetch).not.toHaveBeenCalled();
    const registry = await h.runtime.ModelRegistry.get_model_files('fixture/model', h.options);
    const extra = registry.filter(path => path.includes('/onnx/') || path.startsWith('onnx/')).filter(path => !expected.includes(path));
    expect(extra.sort()).toEqual(fixture.startsWith('qwen')
      ? ['onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data'] : []);
  });

  it('progress metadata prepass contaminates the held-cache plan before session loading', async () => {
    const h = await harness({ config: configFromEvidence({ name: 'qwen3-5-2b' }), progress: 'enabled' });
    const load = h.runtime.AutoModelForCausalLM.from_pretrained('fixture/progress', h.options);
    await vi.waitFor(() => expect(h.artifactPaths()).toContain('onnx/vision_encoder_q4f16.onnx'));
    expect(h.sessionCreate).not.toHaveBeenCalled();
    expect(h.bodyReads).not.toHaveBeenCalled();
    // The observed set already contains the unwanted vision component even
    // though the selected CausalLM creates just two sessions after release.
    h.release.resolve();
    await load;
    expect(h.sessionCreate).toHaveBeenCalledTimes(2);
    expect(h.forbiddenFetch).not.toHaveBeenCalled();
  });

  it('device-specific external-data config changes real requests beyond the registry plan', async () => {
    const h = await harness({
      config: {
        model_type: 'llama', architectures: ['LlamaForCausalLM'],
        num_hidden_layers: 1, num_attention_heads: 1, hidden_size: 8,
        'transformers.js_config': {
          use_external_data_format: false,
          device_config: { webgpu: { use_external_data_format: 2 } },
        },
      },
      progress: 'disabled',
    });
    const load = h.runtime.AutoModelForCausalLM.from_pretrained('fixture/device-config', h.options);
    await vi.waitFor(() => expect(h.artifactPaths()).toEqual([
      'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1',
    ]));
    expect(h.bodyReads).not.toHaveBeenCalled();
    expect(h.sessionCreate).not.toHaveBeenCalled();
    const registry = await h.runtime.ModelRegistry.get_model_files('fixture/device-config', h.options);
    expect(registry.filter(path => path.startsWith('onnx/'))).toEqual(['onnx/model_q4f16.onnx']);
    h.release.resolve();
    await load;
    expect(h.sessionCreate).toHaveBeenCalledTimes(1);
    expect(h.forbiddenFetch).not.toHaveBeenCalled();
  });

  it('a cache lookup delayed beyond quiescence produces an incomplete snapshot in the real bundle', async () => {
    const h = await harness({ config: configFromEvidence({ name: 'qwen3-5-2b' }), progress: 'disabled' });
    const barrier = createModelArtifactRequestBarrier({ quiescenceMs: 10 });
    cleanups.push(() => barrier.dispose());
    const delayed = Promise.withResolvers<void>();
    const seen: string[] = [];
    h.runtime.env.customCache.match = async request => {
      if (!request.includes('/onnx/')) return new Response('{}');
      if (request.endsWith('_data')) await delayed.promise;
      const path = `onnx/${request.split('/onnx/')[1]}`;
      seen.push(path);
      return await barrier.observe({ request: { path, url: `https://huggingface.co/fixture/delay/resolve/${REVISION}/${path}` } });
    };
    // Held forever, as in the production observer; no real model bytes or ORT.
    void h.runtime.AutoModelForCausalLM.from_pretrained('fixture/delay', h.options);
    const snapshot = await barrier.waitForQuiescence();
    expect(snapshot.map(request => request.path)).toEqual([
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx',
    ]);
    delayed.resolve();
    await vi.waitFor(() => expect(seen).toHaveLength(4));
    expect(snapshot).toHaveLength(2);
    expect(h.sessionCreate).not.toHaveBeenCalled();
    expect(h.forbiddenFetch).not.toHaveBeenCalled();
  });

  it('held loads share upstream in-flight entries across revisions in the same module', async () => {
    const h = await harness({ config: configFromEvidence({ name: 'qwen3-5-2b' }), progress: 'disabled' });
    const first = h.runtime.AutoModelForCausalLM.from_pretrained('fixture/revisions', h.options);
    await vi.waitFor(() => expect(h.artifactPaths()).toHaveLength(4));
    const before = h.requests.filter(path => path.includes('/onnx/')).length;
    const second = h.runtime.AutoModelForCausalLM.from_pretrained('fixture/revisions', { ...h.options, revision: 'b'.repeat(40) });
    h.release.resolve();
    await first;
    await second;
    expect(h.requests.filter(path => path.includes('/onnx/'))).toHaveLength(before);
    expect(h.sessionCreate).toHaveBeenCalledTimes(4);
    expect(h.forbiddenFetch).not.toHaveBeenCalled();
  });

  it.each([404, 403, 500, 'transport-error'] as const)(
    'metadata preparation cannot distinguish %s from authoritative absence using the public result',
    async status => {
      const h = await harness({ config: {}, progress: 'disabled' });
      h.runtime.env.allowLocalModels = false;
      h.runtime.env.allowRemoteModels = true;
      h.runtime.env.customCache.match = async () => undefined;
      // Emulate upstream responses locally. Never delegate to native fetch.
      const remoteProbe = vi.fn<typeof fetch>(async () => {
        if (status === 'transport-error') throw new Error('Synthetic transport failure');
        return new Response(undefined, { status });
      });
      h.runtime.env.fetch = remoteProbe;
      const result = await h.runtime.ModelRegistry.get_file_metadata(
        'fixture/metadata-status', 'tokenizer_config.json', { revision: REVISION },
      );
      expect(result).toEqual({ exists: false, fromCache: false });
      expect(remoteProbe).toHaveBeenCalledTimes(1);
      // Assert outside upstream's catch, which also swallows mock exceptions.
      expect(String(remoteProbe.mock.calls[0]?.[0])).toBe(
        `https://huggingface.co/fixture/metadata-status/resolve/${REVISION}/tokenizer_config.json`,
      );
      expect(h.forbiddenFetch).not.toHaveBeenCalled();
      expect(h.bodyReads).not.toHaveBeenCalled();
      expect(h.sessionCreate).not.toHaveBeenCalled();
    },
  );

  it.each(['missing-to-present', 'present-to-missing'] as const)(
    'completed metadata memo survives a same-revision cache change: %s',
    async change => {
      const h = await harness({ config: {}, progress: 'disabled' });
      // Metadata inspection supports cache-only checks with both sources
      // disabled; no model loader is called with this environment setting.
      h.runtime.env.allowLocalModels = false;
      h.runtime.env.allowRemoteModels = false;
      let cached = change === 'present-to-missing';
      const cacheMatch = vi.fn(async () => cached ? new Response('{}') : undefined);
      h.runtime.env.customCache.match = cacheMatch;
      const first = await h.runtime.ModelRegistry.get_file_metadata(
        'fixture/metadata-mutation', 'tokenizer_config.json', { revision: REVISION },
      );
      expect(first.exists).toBe(cached);
      const calls = cacheMatch.mock.calls.length;
      cached = !cached;
      const second = await h.runtime.ModelRegistry.get_file_metadata(
        'fixture/metadata-mutation', 'tokenizer_config.json', { revision: REVISION },
      );
      expect(second).toEqual(first);
      expect(second.exists).not.toBe(cached);
      expect(cacheMatch).toHaveBeenCalledTimes(calls);
      expect(h.forbiddenFetch).not.toHaveBeenCalled();
      expect(h.bodyReads).not.toHaveBeenCalled();
      expect(h.sessionCreate).not.toHaveBeenCalled();
    },
  );
});
