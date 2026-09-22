// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { readUpstreamResourceContract } from './fixtures/read-upstream-resource-contract';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from './fixtures/production-transformers-artifact';
import contract from './upstream-resource-contract.json';

type Runtime = typeof import('@huggingface/transformers');
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.doUnmock('@huggingface/transformers');
  vi.unstubAllGlobals();
});

async function fixture() {
  const artifact = await getProductionTransformersArtifact();
  const unknown: string[] = [];
  const paths: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error('Selector tests forbid network');
  });
  vi.stubGlobal('fetch', fetch);
  cleanup.push(() => expect(fetch).not.toHaveBeenCalled());
  const bundle = new URL(artifact.moduleUrl);
  const ortUrl = artifact.ortWebGpuUrl;
  const ort = await import(/* @vite-ignore */ ortUrl) as { InferenceSession: { create(...args: unknown[]): Promise<unknown> } };
  const session = vi.spyOn(ort.InferenceSession, 'create').mockResolvedValue({ inputNames: [], outputNames: [], release: async () => undefined });
  cleanup.push(() => session.mockRestore());
  const realProcess = globalThis.process;
  vi.stubGlobal('process', { ...realProcess, release: { ...realProcess.release, name: 'browser-test' } });
  vi.stubGlobal('navigator', { gpu: {}, hardwareConcurrency: 2, userAgent: 'Vitest', vendor: '' });
  bundle.searchParams.set('selector-comparison', crypto.randomUUID());
  let runtime: Runtime;
  try {
    runtime = await importProductionTransformersArtifact({ moduleUrl: bundle.href }) as Runtime;
  } finally {
    vi.stubGlobal('process', realProcess);
  }
  runtime.env.allowLocalModels = true;
  runtime.env.allowRemoteModels = false;
  runtime.env.useBrowserCache = false;
  runtime.env.useCustomCache = true;
  runtime.env.useWasmCache = false;
  runtime.env.fetch = fetch;
  runtime.env.customCache = {
    async match(input: string | Request) {
      const url = typeof input === 'string' ? input : input.url;
      const path = url.split('/resolve/' + 'a'.repeat(40) + '/')[1];
      if (path === undefined) return undefined;
      if (path.startsWith('onnx/')) {
        paths.push(path);
        return new Response(new Uint8Array([7, 9, 13]));
      }
      if (path === 'generation_config.json') return new Response('{}');
      unknown.push(path); throw new Error(`Unexpected selector fixture request: ${path}`);
    },
    async put() {
      throw new Error('Read-only selector fixture');
    },
  };
  cleanup.push(() => expect(unknown).toEqual([]));
  vi.resetModules();
  vi.doMock('@huggingface/transformers', () => runtime);
  const { selectProductionModelResources } = await import('./production-resource-selector');
  return { runtime, selectProductionModelResources, session, paths };
}

function textConfig() {
  return { model_type: 'llama', num_hidden_layers: 1, num_attention_heads: 1, hidden_size: 8, num_key_value_heads: 1 };
}

it('pins all native architecture registrations and reviewed upstream selection sources', () => {
  expect(readUpstreamResourceContract({ packageRoot: resolve('node_modules/@huggingface/transformers') })).toEqual(contract);
  expect(Object.keys(contract.classFamilies)).toHaveLength(441);
});

it('keeps existing generic classes and explicitly records three missing upstream exports', async () => {
  const h = await fixture();
  const names = [...new Set([...Object.values(contract.causalClasses), ...Object.values(contract.imageTextClasses)])];
  const missing: string[] = [];
  const overrides: string[] = [];
  for (const name of names) {
    const selected: unknown = Reflect.get(h.runtime, name);
    if (typeof selected !== 'function') missing.push(name);
    else if (Reflect.get(selected, 'from_pretrained') !== h.runtime.PreTrainedModel.from_pretrained) overrides.push(name);
  }
  expect(names).toHaveLength(92);
  expect(overrides).toEqual([]);
  expect(missing.sort()).toEqual(['Ministral3ForCausalLM', 'MinistralForCausalLM', 'Mistral3ForConditionalGeneration']);
  // These are upstream registered-but-unavailable loaders, not new exclusions
  // introduced by the adapter's override guard.
  for (const modelType of ['ministral', 'ministral3', 'mistral3']) {
    const loader = modelType === 'mistral3' ? h.runtime.AutoModelForImageTextToText : h.runtime.AutoModelForCausalLM;
    await expect(loader.from_pretrained('fixture/missing-class', {
      config: new h.runtime.PretrainedConfig({ ...textConfig(), model_type: modelType, text_config: textConfig() }), device: 'webgpu', dtype: 'q4', local_files_only: true,
    })).rejects.toThrow("Cannot read properties of undefined (reading 'from_pretrained')");
  }
  expect(h.session).not.toHaveBeenCalled();
  expect(h.paths).toEqual([]);
});

it('matches CausalLM textOnly selection without Registry vision union', async () => {
  const h = await fixture();
  const config = { model_type: 'qwen3_5', architectures: ['Qwen3_5ForConditionalGeneration'], text_config: textConfig(), 'transformers.js_config': { use_external_data_format: true } };
  const candidate = { device: 'webgpu', dtype: 'q4f16' } as const;
  const expected = ['onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data', 'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data'];
  const plan = h.selectProductionModelResources({ autoClass: 'AutoModelForCausalLM', config, candidate });
  expect(plan.paths).toEqual(expected);
  expect(h.paths).toEqual([]);
  expect(h.session).not.toHaveBeenCalled();
  const model = await h.runtime.AutoModelForCausalLM.from_pretrained('fixture/qwen', { config: new h.runtime.PretrainedConfig(config), ...candidate, revision: 'a'.repeat(40), local_files_only: true });
  expect(h.paths.sort()).toEqual(expected);
  await model.dispose();
});

it('applies device external chunk override before reading any model body', async () => {
  const h = await fixture();
  const config = { ...textConfig(), 'transformers.js_config': { use_external_data_format: false, device_config: { webgpu: { use_external_data_format: 2 } } } };
  const candidate = { device: 'webgpu', dtype: 'q4' } as const;
  const expected = ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data', 'onnx/model_q4.onnx_data_1'];
  expect(h.selectProductionModelResources({ autoClass: 'AutoModelForCausalLM', config, candidate }).paths).toEqual(expected);
  expect(h.session).not.toHaveBeenCalled();
  expect(h.paths).toEqual([]);
  const model = await h.runtime.AutoModelForCausalLM.from_pretrained('fixture/device', { config: new h.runtime.PretrainedConfig(config), ...candidate, revision: 'a'.repeat(40), local_files_only: true });
  expect(h.paths.sort()).toEqual(expected);
  await model.dispose();
});

it('does not reject a valid q4 candidate because an unselected dtype declares too many chunks', async () => {
  const h = await fixture();
  const config = { ...textConfig(), 'transformers.js_config': { use_external_data_format: { 'model_q4.onnx': 1, 'model_fp16.onnx': 101 } } };
  const candidate = { device: 'webgpu', dtype: 'q4' } as const;
  const expected = ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'];
  const model = await h.runtime.AutoModelForCausalLM.from_pretrained('fixture/unselected-dtype', { config: new h.runtime.PretrainedConfig(config), ...candidate, revision: 'a'.repeat(40), local_files_only: true });
  expect(h.paths.sort()).toEqual(expected);
  await model.dispose();
  expect(h.selectProductionModelResources({ autoClass: 'AutoModelForCausalLM', config, candidate }).paths).toEqual(expected);
});

it('offline planning preserves a complete first candidate when a later candidate cannot be planned', async () => {
  const h = await fixture();
  const { planDownloadedModelCandidates } = await import('./plan-downloaded-model-candidates');
  const config = { ...textConfig(), 'transformers.js_config': { use_external_data_format: { 'model_q4f16.onnx': 1, 'model_q4.onnx': 101 } } };
  await expect(planDownloadedModelCandidates({
    modelId: 'fixture/candidates', revision: 'a'.repeat(40),
    candidates: [{ device: 'webgpu', dtype: 'q4f16' }, { device: 'webgpu', dtype: 'q4' }],
    modelCache: { match: async () => new Response(new Uint8Array([1, 2, 3])) },
    getRuntimeFiles: async () => [], workerLocationUrl: 'http://localhost/assets/worker.js',
    getModelFiles: async ({ candidate }) => h.selectProductionModelResources({ autoClass: 'AutoModelForCausalLM', config, candidate }).paths,
  })).resolves.toMatchObject([
    { complete: true, requiredModelPaths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'] },
    { status: 'planning-failed', error: { name: 'ProductionResourceCandidateError' } },
  ]);
  expect(h.session).not.toHaveBeenCalled();
  expect(h.paths).toEqual([]);
});

it('does not validate an unselected device value while resolving the selected device override', async () => {
  const h = await fixture();
  const config = { ...textConfig(), 'transformers.js_config': { use_external_data_format: false, device_config: { wasm: null, webgpu: { use_external_data_format: 1 } } } };
  const candidate = { device: 'webgpu', dtype: 'q4' } as const;
  const expected = ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'];
  const model = await h.runtime.AutoModelForCausalLM.from_pretrained('fixture/unselected-device', { config: new h.runtime.PretrainedConfig(config), ...candidate, revision: 'a'.repeat(40), local_files_only: true });
  expect(h.paths.sort()).toEqual(expected);
  await model.dispose();
  expect(h.selectProductionModelResources({ autoClass: 'AutoModelForCausalLM', config, candidate }).paths).toEqual(expected);
});

it('resolves external declarations by file base rather than the different session key', async () => {
  const h = await fixture();
  const config = { model_type: 'qwen3_5', architectures: ['Qwen3_5ForConditionalGeneration'], is_encoder_decoder: true, text_config: textConfig(), 'transformers.js_config': { use_external_data_format: { encoder_model: 2, model: 7 } } };
  const candidate = { device: 'webgpu', dtype: 'q4' } as const;
  const expected = ['onnx/decoder_model_merged_q4.onnx', 'onnx/embed_tokens_q4.onnx', 'onnx/encoder_model_q4.onnx', 'onnx/encoder_model_q4.onnx_data', 'onnx/encoder_model_q4.onnx_data_1'];
  const plan = h.selectProductionModelResources({ autoClass: 'AutoModelForCausalLM', config, candidate });
  expect(plan.paths).toEqual(expected);
  expect(plan.sessions.find(item => item.key === 'model')?.baseName).toBe('encoder_model');
  expect(h.session).not.toHaveBeenCalled();
  const model = await h.runtime.AutoModelForCausalLM.from_pretrained('fixture/encoder', { config: new h.runtime.PretrainedConfig(config), ...candidate, revision: 'a'.repeat(40), local_files_only: true });
  expect(h.paths.sort()).toEqual(expected);
  await model.dispose();
});

it('does not silently default an unspecified candidate component or accept unquantized candidates', async () => {
  const h = await fixture();
  const select = h.selectProductionModelResources;
  // Deliberately invalid API inputs remain a runtime boundary, not a type claim.
  const invoke = (candidate: unknown) => Reflect.apply(select, undefined, [{ autoClass: 'AutoModelForCausalLM', config: textConfig(), candidate }]);
  expect(() => invoke({ device: 'webgpu' })).toThrow();
  expect(() => invoke({ device: 'webgpu', dtype: 'fp16' })).toThrow();
  expect(() => invoke({ device: 'webgpu', dtype: { decoder_model_merged: 'q4' } })).toThrow();
  expect(h.paths).toEqual([]);
  expect(h.session).not.toHaveBeenCalled();
});

it('preserves null custom configuration defaults and does not mutate the caller input', async () => {
  const h = await fixture();
  const candidate = { device: 'webgpu', dtype: 'q4' } as const;
  const config = { ...textConfig(), 'transformers.js_config': null };
  const original = structuredClone(config);
  expect(h.selectProductionModelResources({ autoClass: 'AutoModelForCausalLM', config, candidate }).paths).toEqual(['onnx/model_q4.onnx']);
  expect(config).toEqual(original);
  const model = await h.runtime.AutoModelForCausalLM.from_pretrained('fixture/null-custom', { config: new h.runtime.PretrainedConfig(config), ...candidate, revision: 'a'.repeat(40), local_files_only: true });
  expect(h.paths).toEqual(['onnx/model_q4.onnx']);
  await model.dispose();
});

it('refuses a new custom loader override without bypassing it or starting model reads', async () => {
  const h = await fixture();
  const override = vi.spyOn(h.runtime.LlamaForCausalLM, 'from_pretrained').mockRejectedValue(new Error('Custom loader must not run during selection'));
  try {
    expect(() => h.selectProductionModelResources({ autoClass: 'AutoModelForCausalLM', config: textConfig(), candidate: { device: 'webgpu', dtype: 'q4' } }))
      .toThrow('Unsupported non-generic');
    expect(override).not.toHaveBeenCalled();
    expect(h.paths).toEqual([]);
    expect(h.session).not.toHaveBeenCalled();
  } finally {
    override.mockRestore();
  }
});

export const TEST_ONLY = {
};
