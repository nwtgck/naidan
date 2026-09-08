import { afterEach, beforeAll, expect, vi } from 'vitest';
import { z } from 'zod';
import { selectTransformersJsProductionAutoClass, selectTransformersJsProductionRuntimeArtifactLoader } from '@/features/transformers-js/production-routing';
import { digest, openRawZip, rawRuntime, restoreRawModel, type RawModel, type ReplayOptions, type ReplayProcessor } from './helpers';

// Shared execution/assertion mechanics only. Model names, expected session
// inventories, processor classes and incompatibilities live in each model test.
let source: Awaited<ReturnType<typeof openRawZip>>;
const active: Array<{ harness: Awaited<ReturnType<typeof rawRuntime>>, expectedUnknown: string[] }> = [];

export function installRawReplay({ evidence }: { evidence: {
  modelId: string, revision: string, files: Record<string, { sha256: string, byteLength: number }>,
} | undefined }) {
  beforeAll(async () => {
    source = await openRawZip({ inputPath: process.env.NAIDAN_REPLAY_ZIP });
    if (evidence !== undefined) {
      const archive = await archiveFor({ modelId: evidence.modelId });
      expect(archive.summary.revision).toBe(evidence.revision);
      expect([...archive.files.keys()].sort()).toEqual(Object.keys(evidence.files).sort());
      for (const [path, expected] of Object.entries(evidence.files)) {
        const bytes = archive.files.get(path)!;
        expect({ sha256: digest({ bytes }), byteLength: bytes.byteLength }, path).toEqual(expected);
      }
    }
  });
  afterEach(() => {
    try {
      for (const { harness: h, expectedUnknown } of active) {
        expect(h.transport).not.toHaveBeenCalled();
        expect(h.mutations).not.toHaveBeenCalled();
        expect(h.unknownRequests).toEqual(expectedUnknown);
      }
    } finally {
      for (const { harness } of active.splice(0)) harness.restoreSessionSpy();
      vi.unstubAllGlobals();
    }
  });
}

export function rawSource() {
  return source;
}

export async function archiveFor({ modelId }: { modelId: string }) {
  const target = source.batch.targets.find(item => item.target === modelId);
  if (target === undefined) throw new Error(`Model absent from explicit raw ZIP: ${modelId}`);
  return restoreRawModel({ zip: source.zip, prefix: target.evidencePath, modelId });
}

export async function start({ archive, bodyPaths }: { archive: RawModel, bodyPaths: string[] }) {
  const harness = await rawRuntime({ archive, bodyPaths });
  const tracked = { harness, expectedUnknown: [] as string[] };
  active.push(tracked);
  return tracked;
}

export function jsonBody({ archive, path }: { archive: RawModel, path: string }): Record<string, unknown> {
  const bytes = archive.files.get(path);
  if (bytes === undefined) throw new Error(`Missing raw JSON: ${path}`);
  return z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder().decode(bytes)));
}

export function pathsFor({ sessions, dtype }: { sessions: Record<string, number>, dtype: 'q4f16' | 'q4' }) {
  return Object.entries(sessions).flatMap(([name, count]) => [
    `onnx/${name}_${dtype}.onnx`,
    ...Array.from({ length: count }, (_value, index) => `onnx/${name}_${dtype}.onnx_data${index === 0 ? '' : `_${index}`}`),
  ]).sort();
}

export async function assertRawTokenizer({ modelId, expectedProcessor, template }: {
  modelId: string,
  expectedProcessor: { processor: string, image: string | undefined, audio: string | undefined } | undefined,
  template: 'render' | 'construction-only',
}) {
  const archive = await archiveFor({ modelId });
  const originalHashes = [...archive.files].map(([path, bytes]) => [path, digest({ bytes })]);
  const { harness: h } = await start({ archive, bodyPaths: [] });
  const modelType = z.string().parse(jsonBody({ archive, path: 'config.json' }).model_type);
  const selector = selectTransformersJsProductionRuntimeArtifactLoader({ modelId, modelType });
  expect(selector === 'tokenizer').toBe(expectedProcessor === undefined);
  const options: ReplayOptions = { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined };
  let processor: ReplayProcessor | undefined;
  const tokenizer = await (async () => {
    switch (selector) {
    case 'tokenizer': return h.runtime.AutoTokenizer.from_pretrained(modelId, options);
    case 'gemma4-processor':
    case 'qwen3_5-processor':
      processor = await h.runtime.AutoProcessor.from_pretrained(modelId, options);
      return processor.tokenizer;
    default: {
      const exhaustive: never = selector;
      throw new Error(`Unhandled processor selector: ${exhaustive}`);
    }
    }
  })();
  if (processor !== undefined) {
    expect(processor.constructor.name).toBe(expectedProcessor!.processor);
    expect(processor.image_processor?.constructor.name).toBe(expectedProcessor!.image);
    expect(processor.feature_extractor?.constructor.name).toBe(expectedProcessor!.audio);
  }
  const ids = tokenizer.encode('Hello world', { add_special_tokens: false });
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.every(id => Number.isSafeInteger(id) && id >= 0)).toBe(true);
  expect(tokenizer.encode('Hello world', { add_special_tokens: false })).toEqual(ids);
  let templateSha256: string | undefined;
  switch (template) {
  case 'render': {
    const rendered = (processor ?? tokenizer).apply_chat_template([{ role: 'user', content: 'Hello world' }], { tokenize: false, add_generation_prompt: true });
    expect(rendered).toContain('Hello world');
    expect(rendered.length).toBeGreaterThan('Hello world'.length);
    templateSha256 = digest({ bytes: new TextEncoder().encode(rendered) });
    break;
  }
  case 'construction-only': break;
  default: {
    const exhaustive: never = template;
    throw new Error(`Unhandled template test: ${exhaustive}`);
  }
  }
  expect(h.bodyReads).toEqual([]);
  expect(h.sessions).not.toHaveBeenCalled();
  expect(h.reads).toContain(`models/huggingface.co/${modelId}/resolve/${archive.summary.revision}/tokenizer.json`);
  expect([...archive.files].map(([path, bytes]) => [path, digest({ bytes })])).toEqual(originalHashes);
  // These fingerprints are observations, not an independent semantic oracle.
  console.info(JSON.stringify({ modelId, selector, ids, templateSha256, requests: [...new Set(h.requests)].sort(), guardedAttempts: h.guardedFetch.mock.calls.map(([input]) => String(input)) }));
}

export async function assertRawModelSelection({ modelId, dtype, sessions, probeOnly, expectedMissing }: {
  modelId: string,
  dtype: 'q4f16' | 'q4',
  sessions: Record<string, number>,
  probeOnly: string[],
  expectedMissing: string[],
}) {
  const archive = await archiveFor({ modelId });
  const expected = pathsFor({ sessions, dtype });
  const observed = [...expected, ...probeOnly].sort();
  const { harness: h } = await start({ archive, bodyPaths: observed });
  const autoClass = selectTransformersJsProductionAutoClass({ modelId });
  const options: ReplayOptions = { revision: archive.summary.revision, local_files_only: true, progress_callback: () => undefined, dtype, device: 'webgpu' };
  const outcome = h.runtime[autoClass].from_pretrained(modelId, options).then(model => ({ model, error: undefined }), error => ({ model: undefined, error }));
  let result: Awaited<typeof outcome>;
  try {
    await vi.waitFor(() => expect([...new Set(h.requests.filter(path => path.startsWith('onnx/')))].sort()).toEqual(observed));
    expect(h.bodyReads).toEqual([]);
    expect(h.sessions).not.toHaveBeenCalled();
  } finally {
    // Every model body is synthetic, including repository-present candidates.
    // For repository-missing cases the model test explicitly labels this as
    // counterfactual: no candidate availability or runtime success is implied.
    h.gate.resolve();
    result = await outcome;
    if (result.model !== undefined) await result.model.dispose();
  }
  expect(result.error).toBeUndefined();
  expect(h.bodyReads.sort()).toEqual(expected);
  expect(h.sessions).toHaveBeenCalledTimes(Object.keys(sessions).length);
  expect(h.released).toHaveBeenCalledTimes(Object.keys(sessions).length);
  const bindings = h.sessions.mock.calls.flatMap(call => {
    expect(call[0]).toBeInstanceOf(Uint8Array);
    expect((call[0] as Uint8Array).byteLength).toBe(1);
    return (z.object({ executionProviders: z.array(z.literal('webgpu')), externalData: z.array(z.object({ path: z.string(), data: z.instanceof(Uint8Array) })).optional() }).parse(call[1]).externalData ?? []).map(item => {
      expect(item.data.byteLength).toBe(1);
      return `onnx/${item.path}`;
    });
  }).sort();
  expect(bindings).toEqual(expected.filter(path => path.includes('.onnx_data')));
  const registry = await h.runtime.ModelRegistry.get_model_files(modelId, { ...options, config: jsonBody({ archive, path: 'config.json' }) });
  expect(registry.filter(path => path.startsWith('onnx/')).sort()).toEqual(observed);
  const target = source.batch.targets.find(item => item.target === modelId)!;
  const repository = z.object({ resolvedRevision: z.string(), files: z.array(z.object({ path: z.string() })) }).parse(JSON.parse(await source.zip.file(`${target.evidencePath}repository/repository.json`)!.async('string')));
  expect(repository.resolvedRevision).toBe(archive.summary.revision);
  const missing = expected.filter(path => !repository.files.some(file => file.path === path));
  expect(missing).toEqual(expectedMissing);
  expect(h.guardedFetch).not.toHaveBeenCalled();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
