import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ModelCandidate } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import type { Request } from '@/features/stable-diffusion-cpp-browser/types';
import { createReadOnlyResources } from './resources-hosted';
import type { PeerImageInput } from './resources';
const mocks = vi.hoisted(() => {
  const commit = 'a'.repeat(40), profile = 'webgpu-wasm32-asyncify';
  return { scan: vi.fn(), opfs: vi.fn(async () => []), host: vi.fn(async () => []), create: vi.fn(), generate: vi.fn(), dispose: vi.fn(),
    configuration: { kind: 'available', sourceCommit: commit, artifacts: [{ profile, modulePath: `stable-diffusion-cpp-runtime/${commit}/${profile}/core.mjs`,
      wasmPath: `stable-diffusion-cpp-runtime/${commit}/${profile}/core.wasm.gz`, helpersPath: `stable-diffusion-cpp-runtime/${commit}/examples/runtime/index.mjs`,
      schemaSha256: 'a'.repeat(64), wasmSha256: 'b'.repeat(64), wasmBytes: 100 }] } };
});
vi.mock('@/features/llama-cpp-browser/index-hosted', () => ({ createReadOnlyLlamaCppClient: () => ({ generate: vi.fn(), dispose: vi.fn(async () => {}) }), llamaCppBrowserService: { listModels: vi.fn(async () => []) } }));
vi.mock('@/features/stable-diffusion-cpp-browser/inference/engine', () => ({ createImageEngineClient: mocks.create }));
vi.mock('@/features/stable-diffusion-cpp-browser/logic/repository-store', () => ({ listImageRepositories: mocks.opfs, listHostImageRepositories: mocks.host }));
vi.mock('@/features/stable-diffusion-cpp-browser/logic/model-candidates', () => ({ scanImageRepositories: mocks.scan }));
vi.mock('@/features/stable-diffusion-cpp-browser/capabilities', () => ({ initialProfile: () => 'webgpu-wasm32-asyncify' }));
vi.mock('virtual:stable-diffusion-cpp-browser/config', () => ({ default: mocks.configuration }));
function candidate({ path, roles }: { path: string, roles: ModelCandidate['roles'] }): ModelCandidate {
  return { id: path, repositoryId: 'user/model', path, roles, classes: [], hostSource: undefined,
    format: 'gguf', size: 16, family: 'sd-checkpoint', evidence: [], issue: undefined, turboHint: false, variant: 'unknown',
    files: [{ path, file: new File([new Uint8Array(16)], path, { lastModified: 123 }) }] };
}
function request(): PeerImageInput {
  return { modelSelection: { primary: { slot: 'model', file: { location: { kind: 'opfs', path: 'models/user/model/model.gguf' }, expected: { size: 16, lastModified: 123 } } }, components: [], loras: [] },
    parameters: { prompt: 'test', negativePrompt: '', width: 256, height: 256, steps: 4, guidance: 7, seed: '42', sampler: 'auto', scheduler: 'auto', distilledGuidance: 3.5 },
    preview: { enabled: false, interval: 1, startStep: 1, mode: 'projection', maxEdge: 0 }, imageInputs: { initial: undefined, references: [], strength: 0.5 } };
}
function resource() {
  return createReadOnlyResources({ directories: () => [] });
}
function generate({ input }: { input: PeerImageInput }) {
  return resource().generateImage({ input, signal: new AbortController().signal, onPreview: () => {}, onProgress: () => {} });
}
beforeEach(() => {
  vi.stubGlobal('window', { location: { href: 'https://local.example/' } });
  vi.clearAllMocks(); mocks.scan.mockResolvedValue({ candidates: [candidate({ path: 'model.gguf', roles: ['model'] })] });
  mocks.create.mockReturnValue({ generate: mocks.generate, dispose: mocks.dispose });
  mocks.generate.mockResolvedValue({ png: new Blob([new Uint8Array(33)], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test' });
});
afterEach(() => vi.unstubAllGlobals());
it('reads catalogs without creating an engine or downloading anything', async () => {
  const catalog = await resource().listImageModels({ signal: new AbortController().signal });
  expect(catalog[0]?.selection?.primary.file.expected).toEqual({ size: 16, lastModified: 123 }); expect(mocks.create).not.toHaveBeenCalled();
});
it('does not advertise a diffusion file as a complete implicit model configuration', async () => {
  mocks.scan.mockResolvedValue({ candidates: [candidate({ path: 'diffusion.gguf', roles: ['diffusion'] })] });
  expect((await resource().listImageModels({ signal: new AbortController().signal }))[0]?.selection).toBeUndefined();
});
it('honors explicit read-only model selection and bounds native-only policies', async () => {
  await generate({ input: request() });
  const actual: Request = mocks.generate.mock.calls[0]![0].request;
  expect(actual.debug).toBe('off'); expect(actual.parameters.conditioningCacheSize).toBe(0); expect(actual.parameters.modelArguments).toBe('');
  expect(actual.models[0]?.file.size).toBe(16); expect(actual.parameters.seed).toBe('42');
  expect(mocks.host).toHaveBeenCalledWith({ directories: [], signal: expect.any(AbortSignal) });
});
it('rejects a changed model before starting an engine', async () => {
  const input = request(); input.modelSelection.primary.file.expected!.size = 19;
  await expect(generate({ input })).rejects.toThrow('changed'); expect(mocks.create).not.toHaveBeenCalled();
});
it('cannot read an ungranted host directory or silently choose the owner preset', async () => {
  const input = request(); input.modelSelection.primary.file = { location: { kind: 'host', directoryId: 'not-granted', path: 'model.gguf' } };
  await expect(generate({ input })).rejects.toThrow('permitted roots'); expect(mocks.create).not.toHaveBeenCalled();
});
it('rejects unsupported sampler values rather than dropping a caller setting', async () => {
  const input = request(); input.parameters.sampler = 'unknown-sampler';
  await expect(generate({ input })).rejects.toThrow(); expect(mocks.create).not.toHaveBeenCalled();
});

it('disposes the cached image owner exactly once and rejects later calls', async () => {
  const resources = resource(), signal = new AbortController().signal;
  await resources.generateImage({ input: request(), signal, onProgress: () => {}, onPreview: () => {} });
  resources.dispose(); resources.dispose(); expect(mocks.dispose).toHaveBeenCalledOnce();
  await expect(resources.listChatModels({ signal })).rejects.toMatchObject({ name: 'AbortError' });
  await expect(resources.listImageModels({ signal })).rejects.toMatchObject({ name: 'AbortError' });
  await expect(resources.generateImage({ input: request(), signal, onProgress: () => {}, onPreview: () => {} })).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.create).toHaveBeenCalledOnce();
});
it('does not create a native image owner when disposed during inventory loading', async () => {
  const resources = resource(), gate = Promise.withResolvers<{ candidates: ModelCandidate[] }>();
  mocks.scan.mockReturnValueOnce(gate.promise);
  const call = resources.generateImage({ input: request(), signal: new AbortController().signal, onProgress: () => {}, onPreview: () => {} });
  const rejected = expect(call).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(mocks.scan).toHaveBeenCalledOnce());
  resources.dispose(); gate.resolve({ candidates: [candidate({ path: 'model.gguf', roles: ['model'] })] }); await rejected;
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
});
it('disposal cancels an in-flight native owner without pretending its result settled', async () => {
  const resources = resource(), gate = Promise.withResolvers<unknown>(); mocks.generate.mockReturnValueOnce(gate.promise);
  const call = resources.generateImage({ input: request(), signal: new AbortController().signal, onProgress: () => {}, onPreview: () => {} });
  const rejected = expect(call).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce());
  const nativeSignal: AbortSignal = mocks.generate.mock.calls[0]![0].signal;
  let settled = false; void call.catch(() => {
    settled = true;
  });
  let retired = false;
  const closing = Promise.resolve(resources.dispose()).then(() => {
    retired = true;
  });
  expect(nativeSignal.aborted).toBe(true); await Promise.resolve(); expect(settled).toBe(false); expect(retired).toBe(false);
  gate.resolve({ png: new Blob([], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test' }); await rejected; await closing;
  expect(retired).toBe(true); expect(mocks.dispose).toHaveBeenCalledOnce();
});
it('preserves a native disposal error rather than acknowledging a successful second disposal', async () => {
  const resources = resource();
  await resources.generateImage({ input: request(), signal: new AbortController().signal, onProgress: () => {}, onPreview: () => {} });
  mocks.dispose.mockImplementationOnce(() => {
    throw new Error('image disposal failed');
  });
  const closing = resources.dispose();
  await expect(closing).rejects.toThrow('image disposal failed');
  expect(resources.dispose()).toBe(closing); expect(mocks.dispose).toHaveBeenCalledOnce();
});

it('waits for an in-flight result even when disposing its image worker throws', async () => {
  const resources = resource(), gate = Promise.withResolvers<unknown>();
  mocks.generate.mockReturnValueOnce(gate.promise);
  const call = resources.generateImage({ input: request(), signal: new AbortController().signal, onProgress: () => {}, onPreview: () => {} });
  const rejected = expect(call).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce());
  mocks.dispose.mockImplementationOnce(() => {
    throw new Error('dispose failed');
  });
  const closing = resources.dispose(); let settled = false;
  void Promise.resolve(closing).then(() => {
    settled = true;
  }, () => {
    settled = true;
  });
  for (let at = 0; at < 12; at++) await Promise.resolve();
  expect(settled).toBe(false);
  const closingFailure = expect(closing).rejects.toThrow('dispose failed');
  gate.resolve({ png: new Blob([], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'test' });
  await rejected; await closingFailure;
  expect(resources.dispose()).toBe(closing);
});
