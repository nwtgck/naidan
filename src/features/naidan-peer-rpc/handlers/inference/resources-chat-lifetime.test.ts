import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LlamaCppWorkerClient } from '@/features/llama-cpp-browser/worker/types';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';

const fixture = vi.hoisted(() => {
  const worker = {
    generate: vi.fn<LlamaCppWorkerClient['generate']>(),
    probeProfiles: vi.fn<LlamaCppWorkerClient['probeProfiles']>(),
    canReuse: vi.fn(() => true),
    dispose: vi.fn(),
    subscribeDisposed: vi.fn(() => () => {}),
  };
  return { worker, create: vi.fn(() => worker), resolve: vi.fn(async () => 'cpu-wasm32') };
});
vi.mock('@/features/llama-cpp-browser/worker/client', () => ({ createLlamaCppWorkerClient: fixture.create }));
vi.mock('@/features/llama-cpp-browser/runtime/detect-profile', () => ({ resolveRuntimeProfile: fixture.resolve }));
vi.mock('@/features/llama-cpp-browser/runtime/model-store', () => ({ listStoredModels: vi.fn(async () => []), removeStoredModel: vi.fn(), withModelMutationLock: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/inference/engine', () => ({ createImageEngineClient: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/logic/repository-store', () => ({ listImageRepositories: vi.fn(), listHostImageRepositories: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/logic/model-candidates', () => ({ scanImageRepositories: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/capabilities', () => ({ initialProfile: vi.fn() }));

let create: typeof import('./resources-hosted')['createReadOnlyResources'];
let service: LlamaCppBrowserService;
const result: Awaited<ReturnType<LlamaCppWorkerClient['generate']>> = { content: 'answer', reasoningContent: '', toolCalls: [], finishReason: 'stop' };
function input(): Parameters<LlamaCppBrowserService['generate']>[0]['input'] {
  return { model: 'local.gguf', messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, maxTokens: 8, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}
function args() {
  return { input: input(), signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {} };
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); fixture.worker.canReuse.mockReturnValue(true);
  fixture.worker.generate.mockResolvedValue(result);
  fixture.worker.probeProfiles.mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  create = (await import('./resources-hosted')).createReadOnlyResources;
  service = (await import('@/features/llama-cpp-browser/index-hosted')).llamaCppBrowserService;
});

afterEach(() => service.release());

it('does not create a native worker to dispose an unused resource owner', async () => {
  const resources = create({ directories: () => [] });
  await resources.dispose(); await resources.dispose();
  expect(fixture.create).not.toHaveBeenCalled();
});

it('releases the chat cache once when its resource owner retires', async () => {
  const resources = create({ directories: () => [] });
  await resources.generateChat(args());
  expect(fixture.worker.probeProfiles).not.toHaveBeenCalled();
  await resources.dispose(); await resources.dispose();
  expect(fixture.worker.dispose).toHaveBeenCalledOnce();
  expect(service.getState()).toEqual({ status: 'idle' });
});

it('does not evict the cache that a later local generation took over', async () => {
  const resources = create({ directories: () => [] });
  await resources.generateChat(args());
  await service.generate({ input: input(), signal: undefined, onEvent: () => {} });
  await resources.dispose();
  expect(fixture.worker.dispose).not.toHaveBeenCalled();
  await service.generate({ input: input(), signal: undefined, onEvent: () => {} });
  expect(fixture.create).toHaveBeenCalledOnce();
});

it('distinguishes two resource owners using the same native worker', async () => {
  const a = create({ directories: () => [] }), b = create({ directories: () => [] });
  await a.generateChat(args()); await b.generateChat(args());
  await a.dispose(); expect(fixture.worker.dispose).not.toHaveBeenCalled();
  await b.dispose(); expect(fixture.worker.dispose).toHaveBeenCalledOnce();
});

it('does not acknowledge disposal before a cancelled chat physically retires', async () => {
  const resources = create({ directories: () => [] });
  const gate = Promise.withResolvers<typeof result>(); fixture.worker.generate.mockReturnValueOnce(gate.promise);
  const pending = resources.generateChat(args()); const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(fixture.worker.generate).toHaveBeenCalledOnce());
  let retired = false;
  const closing = Promise.resolve(resources.dispose()).then(() => {
    retired = true;
  });
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(fixture.worker.generate.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(retired).toBe(false); expect(fixture.worker.dispose).not.toHaveBeenCalled();
  } finally {
    gate.resolve(result); await rejected; await closing;
  }
  expect(fixture.worker.dispose).toHaveBeenCalledOnce();
});

it('does not tear down a queued local call while retiring the previous owner', async () => {
  const resources = create({ directories: () => [] });
  const remote = Promise.withResolvers<typeof result>(), local = Promise.withResolvers<typeof result>();
  fixture.worker.generate.mockReturnValueOnce(remote.promise).mockReturnValueOnce(local.promise);
  const pending = resources.generateChat(args()); const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(fixture.worker.generate).toHaveBeenCalledOnce());
  const localCall = service.generate({ input: input(), signal: undefined, onEvent: () => {} });
  const closing = Promise.resolve(resources.dispose());
  try {
    remote.resolve(result); await rejected;
    await vi.waitFor(() => expect(fixture.worker.generate).toHaveBeenCalledTimes(2));
    expect(fixture.worker.generate.mock.calls[1]![0].signal?.aborted).toBe(false);
    expect(fixture.worker.dispose).not.toHaveBeenCalled();
  } finally {
    local.resolve(result); await localCall; await closing;
  }
  expect(fixture.worker.dispose).not.toHaveBeenCalled();
});
