import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import capturedCorpus from '@/features/transformers-js/model-support-investigation/logic/fixtures/replay-metadata-corpus.json';
import { selectTransformersJsProductionAutoClass } from '@/features/transformers-js/production-routing';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';

const corpus = z.object({
  schemaVersion: z.literal(1),
  source: z.object({ zipSha256: z.string(), representation: z.literal('parsed-json-not-original-bytes'), note: z.string() }).strict(),
  models: z.array(z.object({
    modelId: z.string(), revision: z.string().regex(/^[a-f0-9]{40}$/u),
    repositoryFiles: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() }).strict()),
    declarations: z.array(z.object({ path: z.string(), originalByteLength: z.number().int().nonnegative(), value: z.record(z.string(), z.unknown()) }).strict()),
  }).strict()).length(9),
}).strict().parse(capturedCorpus);

type Fixture = typeof corpus.models[number];
type Dtype = 'q4f16' | 'q4';
type Options = { revision: string; device: 'webgpu'; dtype: Dtype; local_files_only: true; progress_callback?: () => void };
interface ModelStub { dispose(): Promise<void> }
interface WebModule {
  env: {
    allowLocalModels: boolean; allowRemoteModels: boolean; useBrowserCache: boolean; useCustomCache: boolean; useWasmCache: boolean;
    fetch: typeof fetch;
    customCache: { match(request: string): Promise<Response | undefined>; put(): Promise<void> };
  };
  AutoModelForCausalLM: { from_pretrained(modelId: string, options: Options): Promise<ModelStub> };
  AutoModelForImageTextToText: WebModule['AutoModelForCausalLM'];
  ModelRegistry: { get_model_files(modelId: string, options: Options & { config: Record<string, unknown> }): Promise<string[]> };
}

const EXPECTED: Array<{ modelId: string; chunks: Record<Dtype, Record<string, number>>; registryExtra: string[]; missing: Dtype[] }> = [
  { modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', chunks: { q4f16: { model: 0 }, q4: { model: 0 } }, registryExtra: [], missing: [] },
  { modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', chunks: { q4f16: { model: 0 }, q4: { model: 0 } }, registryExtra: [], missing: [] },
  { modelId: 'LiquidAI/LFM2.5-2.6B-ONNX', chunks: { q4f16: { model: 2 }, q4: { model: 1 } }, registryExtra: [], missing: [] },
  { modelId: 'LiquidAI/LFM2.5-230M-ONNX', chunks: { q4f16: { model: 1 }, q4: { model: 1 } }, registryExtra: [], missing: ['q4f16'] },
  { modelId: 'LiquidAI/LFM2.5-350M-ONNX', chunks: { q4f16: { model: 1 }, q4: { model: 1 } }, registryExtra: [], missing: [] },
  { modelId: 'onnx-community/gemma-4-E2B-it-ONNX', chunks: { q4f16: { audio_encoder: 1, decoder_model_merged: 1, embed_tokens: 1, vision_encoder: 1 }, q4: { audio_encoder: 1, decoder_model_merged: 1, embed_tokens: 1, vision_encoder: 1 } }, registryExtra: [], missing: [] },
  { modelId: 'onnx-community/gpt-oss-20b-ONNX', chunks: { q4f16: { model: 7 }, q4: { model: 0 } }, registryExtra: [], missing: ['q4'] },
  { modelId: 'onnx-community/Qwen3.5-2B-ONNX', chunks: { q4f16: { decoder_model_merged: 1, embed_tokens: 1 }, q4: { decoder_model_merged: 1, embed_tokens: 1 } }, registryExtra: ['vision_encoder'], missing: [] },
  { modelId: 'onnx-community/Qwen3.5-4B-ONNX', chunks: { q4f16: { decoder_model_merged: 2, embed_tokens: 1 }, q4: { decoder_model_merged: 2, embed_tokens: 1 } }, registryExtra: ['vision_encoder'], missing: [] },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
});

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

describe('captured metadata to actual installed TJS model requests', () => {
  it('pins the source ZIP and original upstream bundle underlying the production artifact', () => {
    expect(corpus.source.zipSha256).toBe('41b6073f0a3f0351171304c75ae7954895ddb97deb548839e302cc14c61ef7b0');
    const bundle = readFileSync(resolve(process.cwd(), 'node_modules/@huggingface/transformers/dist/transformers.web.js'));
    expect(createHash('sha256').update(bundle).digest('hex')).toBe('25e0cbdf5df922996299fcd2cf835101ba979b134389a0dcc54f92022ca7e0ff');
    expect(corpus.models.map(model => model.modelId)).toEqual(EXPECTED.map(model => model.modelId));
  });

  it.each(EXPECTED.flatMap(expected => (['q4f16', 'q4'] as const).map(dtype => ({ expected, dtype, modelId: expected.modelId }))))(
    'replays unmodified $modelId config at $dtype through the current Production AutoClass',
    async ({ expected, dtype, modelId }) => {
      const fixture = corpus.models.find(model => model.modelId === modelId)!;
      const capturedBefore = JSON.stringify(fixture.declarations);
      const h = await harness({ fixture, dtype });
      const autoClass = selectTransformersJsProductionAutoClass({ modelId });
      expect(autoClass).toBe(modelId.includes('gemma-4') ? 'AutoModelForImageTextToText' : 'AutoModelForCausalLM');
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
        if (result.status === 'completed') await result.model.dispose();
      }
      expect(result.status, result.status === 'rejected' ? String(result.error) : undefined).toBe('completed');
      if (result.status !== 'completed') throw result.error;
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
    },
  );

  it.each(EXPECTED.filter(expected => expected.registryExtra.length > 0).flatMap(expected => (['q4f16', 'q4'] as const).map(dtype => ({ expected, dtype, modelId: expected.modelId }))))(
    'distinguishes current Production progress metadata prepass from actual $modelId $dtype body consumption',
    async ({ expected, dtype, modelId }) => {
      const fixture = corpus.models.find(model => model.modelId === modelId)!;
      const h = await harness({ fixture, dtype });
      const consumed = expectedPaths({ chunks: expected.chunks[dtype], dtype });
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
        if (result.status === 'completed') await result.model.dispose();
      }
      expect(result.status, result.status === 'rejected' ? String(result.error) : undefined).toBe('completed');
      expect(h.paths()).toEqual(observed);
      expect(h.syntheticBodyReads.sort()).toEqual(consumed);
      expect(h.sessionCreate).toHaveBeenCalledTimes(2);
      expect(h.metadataReads.sort()).toEqual(['config.json', 'generation_config.json']);
      expect(h.unknownRequests).toEqual([]);
      expect(h.cacheWrites).not.toHaveBeenCalled();
      expect(h.forbiddenFetch).not.toHaveBeenCalled();
    },
  );

  it('extends the older seven-model corpus without inventing old metadata coverage', () => {
    const directory = resolve(process.cwd(), 'src/features/transformers-js/download-verification/fixtures/repositories');
    const olderSchema = z.object({ modelId: z.string(), resolvedRevision: z.string(), modelType: z.string(), architectures: z.array(z.string()), transformersJsConfig: z.record(z.string(), z.unknown()), files: z.array(z.object({ path: z.string() }).passthrough()) }).passthrough();
    const older = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => olderSchema.parse(JSON.parse(readFileSync(resolve(directory, name), 'utf8'))));
    expect(older).toHaveLength(7);
    for (const previous of older) {
      const current = corpus.models.find(model => model.modelId === previous.modelId)!;
      const config = current.declarations.find(file => file.path === 'config.json')!.value;
      expect(current.revision).toBe(previous.resolvedRevision);
      expect(config.model_type).toBe(previous.modelType);
      expect(config.architectures).toEqual(previous.architectures);
      expect(config['transformers.js_config']).toEqual(previous.transformersJsConfig);
      expect(current.repositoryFiles.filter(file => file.path.startsWith('onnx/')).map(file => file.path).sort()).toEqual(previous.files.filter(file => file.path.startsWith('onnx/')).map(file => file.path).sort());
    }
    expect(corpus.models.filter(model => !older.some(previous => previous.modelId === model.modelId)).map(model => model.modelId)).toEqual(['HuggingFaceTB/SmolLM2-1.7B-Instruct', 'LiquidAI/LFM2.5-350M-ONNX']);
  });
});
