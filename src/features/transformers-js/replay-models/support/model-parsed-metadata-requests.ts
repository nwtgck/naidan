import { expect, vi } from 'vitest';
import { z } from 'zod';
import { selectTransformersJsProductionAutoClass } from '@/features/transformers-js/production-routing';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';

export const parsedMetadataFixtureSchema = z.object({
  modelId: z.string(), revision: z.string().regex(/^[a-f0-9]{40}$/u),
  repositoryFiles: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() }).strict()),
  declarations: z.array(z.object({ path: z.string(), originalByteLength: z.number().int().nonnegative(), value: z.record(z.string(), z.unknown()) }).strict()),
}).strict();

type Fixture = z.infer<typeof parsedMetadataFixtureSchema>;
type Dtype = 'q4f16' | 'q4';
type Options = { revision: string; device: 'webgpu'; dtype: Dtype; local_files_only: true; progress_callback?: () => void };
interface ModelStub { dispose(): Promise<void> }
interface WebModule {
  env: {
    allowLocalModels: boolean; allowRemoteModels: boolean; useBrowserCache: boolean; useCustomCache: boolean; useWasmCache: boolean;
    fetch: typeof fetch;
    // eslint-disable-next-line local-rules-named-args/require-named-args -- External Transformers.js cache interface.
    customCache: { match(request: string): Promise<Response | undefined>; put(): Promise<void> };
  };
  // eslint-disable-next-line local-rules-named-args/require-named-args -- External Transformers.js model loader.
  AutoModelForCausalLM: { from_pretrained(modelId: string, options: Options): Promise<ModelStub> };
  AutoModelForImageTextToText: WebModule['AutoModelForCausalLM'];
  // eslint-disable-next-line local-rules-named-args/require-named-args -- External Transformers.js registry interface.
  ModelRegistry: { get_model_files(modelId: string, options: Options & { config: Record<string, unknown> }): Promise<string[]> };
}

type Expected = { modelId: string; chunks: Record<Dtype, Record<string, number>>; registryExtra: string[]; missing: Dtype[] };

async function disposeSuccessfulReplayModel({ result }: {
  result: { status: 'completed'; model: ModelStub } | { status: 'rejected'; error: unknown };
}) {
  switch (result.status) {
  case 'completed': await result.model.dispose(); break;
  case 'rejected': break;
  default: { const exhaustive: never = result; throw new Error(`Unexpected result: ${exhaustive}`); }
  }
}

const cleanups: Array<() => void> = [];
export function cleanupParsedMetadataRequests() {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
}

function expectedPaths({ chunks, dtype }: { chunks: Record<string, number>, dtype: Dtype }): string[] {
  return Object.entries(chunks).flatMap(([name, count]) => [
    `onnx/${name}_${dtype}.onnx`,
    ...Array.from({ length: count }, (_value, index) => `onnx/${name}_${dtype}.onnx_data${index === 0 ? '' : `_${index}`}`),
  ]).sort();
}

async function harness({ fixture, dtype }: { fixture: Fixture, dtype: Dtype }) {
  const artifact = await getProductionTransformersArtifact();
  const forbiddenFetch = vi.fn<typeof fetch>(async () => {
    throw new Error('External fetch forbidden in metadata model replay');
  });
  vi.stubGlobal('fetch', forbiddenFetch);
  const url = new URL(artifact.moduleUrl);
  // Match the exact ESM ORT class imported by the production artifact. A CJS
  // spy or the Node TJS export would measure a different runtime.
  const ortUrl = artifact.ortWebGpuUrl;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- External native ORT overload, not a Naidan facade.
  const ort = await import(/* @vite-ignore */ ortUrl) as { InferenceSession: { create(...args: unknown[]): Promise<unknown> } };
  const sessionRelease = vi.fn(async () => undefined);
  const sessionCreate = vi.spyOn(ort.InferenceSession, 'create').mockImplementation(async () => ({
    inputNames: [], outputNames: [], release: sessionRelease,
  }));
  cleanups.push(() => sessionCreate.mockRestore());
  url.searchParams.set('metadata-model-replay', crypto.randomUUID());
  const originalProcess = globalThis.process;
  const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {} });
  cleanups.push(() => {
    if (originalGpu === undefined) Reflect.deleteProperty(navigator, 'gpu');
    else Object.defineProperty(navigator, 'gpu', originalGpu);
  });
  // Browser branch selection only; this does not emulate a GPU or browser Worker.
  vi.stubGlobal('process', { ...originalProcess, release: { ...originalProcess.release, name: 'browser-test' } });
  let runtime: WebModule;
  try {
    runtime = await importProductionTransformersArtifact({ moduleUrl: url.href }) as WebModule;
  } finally {
    vi.stubGlobal('process', originalProcess);
  }
  Object.assign(runtime.env, {
    allowLocalModels: true, allowRemoteModels: false, useBrowserCache: false,
    useCustomCache: true, useWasmCache: false, fetch: forbiddenFetch,
  });
  const gate = Promise.withResolvers<void>();
  const requests: Array<{ request: string; path: string }> = [];
  const unknownRequests: string[] = [];
  const metadataReads: string[] = [];
  const syntheticBodyReads: string[] = [];
  const cacheWrites = vi.fn(async () => {
    throw new Error('Replay must not write model cache');
  });
  const declarations = new Map(fixture.declarations.map(file => [file.path, JSON.stringify(file.value)]));
  runtime.env.customCache = {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the external Transformers.js cache interface.
    async match(request) {
      const marker = `${fixture.modelId}/`;
      const index = request.indexOf(marker);
      if (index < 0) {
        unknownRequests.push(request); throw new Error('Unexpected model identity');
      }
      let path = request.slice(index + marker.length);
      if (path.startsWith('resolve/')) {
        const revisionPrefix = `resolve/${fixture.revision}/`;
        if (!path.startsWith(revisionPrefix)) {
          unknownRequests.push(request); throw new Error('Unexpected revision');
        }
        path = path.slice(revisionPrefix.length);
      }
      requests.push({ request, path });
      if (path.startsWith('onnx/')) {
        await gate.promise;
        // Deliberately counterfactual for missing candidates too: these one-byte
        // bodies only drain the upstream request graph against an ORT spy. They
        // do not turn absent files into complete/accepted repository candidates.
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            syntheticBodyReads.push(path);
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }, { highWaterMark: 0 }), { headers: { 'Content-Length': '1' } });
      }
      const serialized = declarations.get(path);
      if (serialized === undefined) {
        unknownRequests.push(request); throw new Error('Uncaptured metadata request');
      }
      const bytes = new TextEncoder().encode(serialized);
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          metadataReads.push(path);
          controller.enqueue(bytes);
          controller.close();
        },
      }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length) } });
    },
    put: cacheWrites,
  };
  const paths = () => [...new Set(requests.filter(item => item.path.startsWith('onnx/')).map(item => item.path))].sort();
  const options: Options = { revision: fixture.revision, dtype, device: 'webgpu', local_files_only: true };
  return { runtime, options, gate, paths, requests, unknownRequests, metadataReads, syntheticBodyReads, sessionCreate, sessionRelease, forbiddenFetch, cacheWrites };
}

// The model owns the expected route and artifact contract; this helper only observes and compares.
export async function assertParsedMetadataModelRequest({ fixture, expected, dtype, expectedAutoClass }: {
  fixture: Fixture; expected: Expected; dtype: Dtype; expectedAutoClass: 'AutoModelForCausalLM' | 'AutoModelForImageTextToText';
}) {
  const modelId = expected.modelId;
  const capturedBefore = JSON.stringify(fixture.declarations);
  const h = await harness({ fixture, dtype });
  const modelType = z.string().parse(fixture.declarations.find(file => file.path === 'config.json')!.value.model_type);
  const autoClass = selectTransformersJsProductionAutoClass({ modelId, modelType });
  expect(autoClass).toBe(expectedAutoClass);
  const outcome = h.runtime[autoClass].from_pretrained(modelId, h.options).then(
    model => ({ status: 'completed' as const, model }),
    error => ({ status: 'rejected' as const, error }),
  );
  const expectedArtifacts = expectedPaths({ chunks: expected.chunks[dtype], dtype });
  let result: Awaited<typeof outcome>;
  try {
    await vi.waitFor(() => expect(h.paths()).toEqual(expectedArtifacts));
    expect(h.syntheticBodyReads).toEqual([]);
    expect(h.sessionCreate).not.toHaveBeenCalled();
  } finally {
    h.gate.resolve();
    // Keep the ORT spy installed until already-entered work has drained,
    // even when a held-set assertion fails.
    result = await outcome;
    await disposeSuccessfulReplayModel({ result });
  }
  switch (result.status) {
  case 'completed': expect(result.status).toBe('completed'); break;
  case 'rejected': expect(result.status, String(result.error)).toBe('completed'); throw result.error;
  default: { const exhaustive: never = result; throw new Error(`Unexpected result: ${exhaustive}`); }
  }
  expect(h.paths()).toEqual(expectedArtifacts);
  expect(h.syntheticBodyReads.sort()).toEqual(expectedArtifacts);
  expect(h.sessionCreate).toHaveBeenCalledTimes(Object.keys(expected.chunks[dtype]).length);
  expect(h.sessionRelease).toHaveBeenCalledTimes(Object.keys(expected.chunks[dtype]).length);
  expect([...new Set(h.metadataReads)].sort()).toEqual(['config.json', 'generation_config.json']);
  expect(h.metadataReads).toHaveLength(2);
  const bindingSchema = z.object({
    executionProviders: z.array(z.literal('webgpu')),
    externalData: z.array(z.object({ path: z.string(), data: z.instanceof(Uint8Array) }).passthrough()).optional(),
  }).passthrough();
  const bindings = h.sessionCreate.mock.calls.flatMap(call => {
    expect(call[0]).toBeInstanceOf(Uint8Array);
    expect((call[0] as Uint8Array).byteLength).toBe(1);
    return (bindingSchema.parse(call[1]).externalData ?? []).map(external => {
      expect(external.data.byteLength).toBe(1);
      return `onnx/${external.path}`;
    });
  }).sort();
  expect(bindings).toEqual(expectedArtifacts.filter(path => path.includes('.onnx_data')));
  const config = fixture.declarations.find(file => file.path === 'config.json')!.value;
  // Registry's get_model_files ignores revision; Naidan also supplies a
  // preloaded config. Do not silently resolve mutable main in this comparison.
  const registry = await h.runtime.ModelRegistry.get_model_files(modelId, { ...h.options, config: structuredClone(config) });
  const registryArtifacts = registry.filter(path => path.startsWith('onnx/')).sort();
  const extras = expected.registryExtra.flatMap(name => [`onnx/${name}_${dtype}.onnx`, `onnx/${name}_${dtype}.onnx_data`]).sort();
  expect(registryArtifacts.filter(path => !expectedArtifacts.includes(path))).toEqual(extras);
  expect(expectedArtifacts.filter(path => !registryArtifacts.includes(path))).toEqual([]);
  const repositoryPaths = new Set(fixture.repositoryFiles.map(file => file.path));
  expect(expectedArtifacts.filter(path => !repositoryPaths.has(path))).toEqual(expected.missing.some(value => value === dtype) ? expectedArtifacts : []);
  expect(h.unknownRequests).toEqual([]);
  expect(h.forbiddenFetch).not.toHaveBeenCalled();
  expect(h.cacheWrites).not.toHaveBeenCalled();
  expect(JSON.stringify(fixture.declarations)).toBe(capturedBefore);
}

// This explicit Causal route is a planner counterexample, not current Production model routing.
export async function assertCausalMetadataPrepass({ fixture, dtype, expectedConsumedPaths }: {
  fixture: Fixture; dtype: Dtype; expectedConsumedPaths: string[];
}) {
  const h = await harness({ fixture, dtype });
  const modelId = fixture.modelId;
  const consumed = expectedConsumedPaths;
  const vision = [`onnx/vision_encoder_${dtype}.onnx`, `onnx/vision_encoder_${dtype}.onnx_data`];
  const observed = [...consumed, ...vision].sort();
  const outcome = h.runtime.AutoModelForCausalLM.from_pretrained(modelId, { ...h.options, progress_callback: () => undefined }).then(
    model => ({ status: 'completed' as const, model }),
    error => ({ status: 'rejected' as const, error }),
  );
  let result: Awaited<typeof outcome>;
  try {
    await vi.waitFor(() => expect(h.paths()).toEqual(observed));
    expect(h.syntheticBodyReads).toEqual([]);
    expect(h.sessionCreate).not.toHaveBeenCalled();
  } finally {
    h.gate.resolve();
    result = await outcome;
    await disposeSuccessfulReplayModel({ result });
  }
  switch (result.status) {
  case 'completed': expect(result.status).toBe('completed'); break;
  case 'rejected': expect(result.status, String(result.error)).toBe('completed'); break;
  default: { const exhaustive: never = result; throw new Error(`Unexpected result: ${exhaustive}`); }
  }
  expect(h.paths()).toEqual(observed);
  expect(h.syntheticBodyReads.sort()).toEqual(consumed);
  expect(h.sessionCreate).toHaveBeenCalledTimes(2);
  expect(h.metadataReads.sort()).toEqual(['config.json', 'generation_config.json']);
  expect(h.unknownRequests).toEqual([]);
  expect(h.cacheWrites).not.toHaveBeenCalled();
  expect(h.forbiddenFetch).not.toHaveBeenCalled();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
