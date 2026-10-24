import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LlamaCppWorkerClient } from '@/features/llama-cpp-browser/worker/types';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { storageService } from '@/00-storage/service';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { llamaCppBrowserService as service } from '@/features/llama-cpp-browser/index-hosted';
import { createReadOnlyResources as create } from './resources-hosted';

const fixture = vi.hoisted(() => {
  const worker = {
    generate: vi.fn<LlamaCppWorkerClient['generate']>(),
    probeProfiles: vi.fn<LlamaCppWorkerClient['probeProfiles']>(),
    canReuse: vi.fn(() => true),
    dispose: vi.fn(),
    subscribeDisposed: vi.fn(() => () => {}),
  };
  // Each acquisition is a distinct Worker; retired instances must not be
  // resurrected when the service keeps its retirement WeakMap across tests.
  return { worker, create: vi.fn(() => ({ ...worker })), resolve: vi.fn(async () => 'cpu-wasm32') };
});
vi.mock('@/features/llama-cpp-browser/worker/client', () => ({ createLlamaCppWorkerClient: fixture.create }));
vi.mock('@/features/llama-cpp-browser/runtime/detect-profile', () => ({ resolveRuntimeProfile: fixture.resolve }));
vi.mock('@/features/llama-cpp-browser/runtime/model-store', () => ({ listStoredModels: vi.fn(async () => []), removeStoredModel: vi.fn(), withModelMutationLock: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/inference/engine', () => ({ createImageEngineClient: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/logic/repository-store', () => ({ listImageRepositories: vi.fn(), listHostImageRepositories: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/logic/model-candidates', () => ({ scanImageRepositories: vi.fn() }));
vi.mock('@/features/stable-diffusion-cpp-browser/capabilities', () => ({ initialProfile: vi.fn() }));

const result: Awaited<ReturnType<LlamaCppWorkerClient['generate']>> = { content: 'answer', reasoningContent: '', toolCalls: [], finishReason: 'stop' };

function input(): Parameters<LlamaCppBrowserService['generate']>[0]['input'] {
  return { modelId: 'temp/lifetime-GGUF', messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, maxTokens: 8, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}

function args() {
  return { input: input(), signal: new AbortController().signal, onEvent: () => {}, onProgress: () => {} };
}

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.worker.canReuse.mockReturnValue(true);
  vi.spyOn(storageService, 'loadSettings').mockResolvedValue(null);
  fixture.worker.generate.mockReset().mockResolvedValue(result);
  fixture.worker.probeProfiles.mockReset().mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  const bytes = new Uint8Array(32);
  bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
  const file = new File([bytes], 'lifetime.gguf');
  Object.defineProperty(file, 'slice', { value: (start: number, end: number) => new NodeBlob([bytes.slice(start, end)]) });
  await service.importModel({ file, storage: 'temp', signal: undefined });
});

afterEach(() => {
  service.release();
  // Keep module instances (and their subscriptions) stable; explicitly release
  // the page-local state instead of re-importing the storage/runtime graph.
  for (const root of temporaryModelFiles.list()) {
    temporaryModelFiles.remove({ rootPath: root.rootPath });
  }
  vi.restoreAllMocks();
});

it('does not create a native worker to dispose an unused resource owner', async () => {
  const resources = create({ directories: () => [] });
  await resources.dispose();
  await resources.dispose();
  expect(fixture.create).not.toHaveBeenCalled();
});

it.each(['', 'unknown', 'user/../outside', 'temp/not-registered'])('fails current model resolution before starting a worker for %j', async modelId => {
  const resources = create({ directories: () => [] });
  await using _resources = {
    async [Symbol.asyncDispose]() {
      await resources.dispose();
    },
  };
  await expect(resources.generateChat({ ...args(), input: { ...input(), modelId } })).rejects.toThrow('missing-model');
  expect(fixture.create).not.toHaveBeenCalled();
  expect(fixture.worker.generate).not.toHaveBeenCalled();
});

it('releases the chat cache once when its resource owner retires', async () => {
  const resources = create({ directories: () => [] });
  await resources.generateChat(args());
  expect(fixture.worker.probeProfiles).not.toHaveBeenCalled();
  await resources.dispose();
  await resources.dispose();
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
  await a.generateChat(args());
  await b.generateChat(args());
  await a.dispose();
  expect(fixture.worker.dispose).not.toHaveBeenCalled();
  await b.dispose();
  expect(fixture.worker.dispose).toHaveBeenCalledOnce();
});

it('does not acknowledge disposal before a cancelled chat physically retires', async () => {
  const resources = create({ directories: () => [] });
  const gate = Promise.withResolvers<typeof result>();
  fixture.worker.generate.mockReturnValueOnce(gate.promise);
  const pending = resources.generateChat(args());
  const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(fixture.worker.generate).toHaveBeenCalledOnce());
  let retired = false;
  const closing = Promise.resolve(resources.dispose()).then(() => {
    retired = true;
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.worker.generate.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(retired).toBe(false);
    expect(fixture.worker.dispose).not.toHaveBeenCalled();
  } finally {
    gate.resolve(result);
    await rejected;
    await closing;
  }
  expect(fixture.worker.dispose).toHaveBeenCalledOnce();
});

it('does not tear down a queued local call while retiring the previous owner', async () => {
  const resources = create({ directories: () => [] });
  const remote = Promise.withResolvers<typeof result>(), local = Promise.withResolvers<typeof result>();
  fixture.worker.generate.mockReturnValueOnce(remote.promise).mockReturnValueOnce(local.promise);
  const pending = resources.generateChat(args());
  const rejected = expect(pending).rejects.toBeDefined();
  await vi.waitFor(() => expect(fixture.worker.generate).toHaveBeenCalledOnce());
  const localCall = service.generate({ input: input(), signal: undefined, onEvent: () => {} });
  const closing = Promise.resolve(resources.dispose());
  try {
    remote.resolve(result);
    await rejected;
    await vi.waitFor(() => expect(fixture.worker.generate).toHaveBeenCalledTimes(2));
    expect(fixture.worker.generate.mock.calls[1]![0].signal?.aborted).toBe(false);
    expect(fixture.worker.dispose).not.toHaveBeenCalled();
  } finally {
    local.resolve(result);
    await localCall;
    await closing;
  }
  expect(fixture.worker.dispose).not.toHaveBeenCalled();
});

it("advertises and serves this page's temporary models through the ordinary RPC resources", async () => {
  const bytes = new Uint8Array(32);
  bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
  const file = new File([bytes], 'rpc-local.gguf');
  Object.defineProperty(file, 'slice', { value: (start: number, end: number) => new NodeBlob([bytes.slice(start, end)]) });
  await service.importModel({ file, storage: 'temp', signal: undefined });
  const id = 'temp/rpc-local-GGUF';
  await using _model = { [Symbol.asyncDispose]: () => service.removeTemporaryModel({ modelId: id, signal: undefined }) };
  const resources = create({ directories: () => [] });
  await using _resources = {
    [Symbol.asyncDispose]: async () => {
      await resources.dispose();
    },
  };
  expect(await resources.listChatModels({ signal: new AbortController().signal })).toContainEqual({ modelId: id });
  expect(fixture.create).not.toHaveBeenCalled();
  await expect(resources.generateChat({ ...args(), input: { ...input(), modelId: id } })).resolves.toEqual(result);
  expect(fixture.worker.generate).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ modelId: id }) }));
  await resources.dispose();
  // Retiring RPC/native resources does not unregister the page's model files.
  expect((await service.listModelEntries({ signal: undefined })).map(model => model.modelId)).toContain(id);
});
