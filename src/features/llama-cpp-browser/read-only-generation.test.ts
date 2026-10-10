import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LlamaCppWorkerClient } from './worker/types';
import type { LlamaCppBrowserService } from './service-contract';
import type { ProfileCapabilities } from './runtime/profile-capabilities';
const fixture = vi.hoisted(() => ({
  generate: vi.fn<LlamaCppWorkerClient['generate']>(),
  probeProfiles: vi.fn<LlamaCppWorkerClient['probeProfiles']>(),
  prepareModel: vi.fn<LlamaCppWorkerClient['prepareModel']>(),
  dispose: vi.fn(),
  subscribeDisposed: vi.fn(() => () => {}),
  canReuse: vi.fn(() => true),
  resolve: vi.fn(async () => 'cpu-wasm32'),
}));
vi.mock('@/features/llama-cpp-browser/worker/client', () => ({ createLlamaCppWorkerClient: () => ({ ...fixture }) }));
vi.mock('@/features/llama-cpp-browser/runtime/detect-profile', () => ({ resolveRuntimeProfile: fixture.resolve }));
vi.mock('@/features/llama-cpp-browser/runtime/model-store', () => ({ listStoredModels: vi.fn(async () => []), removeStoredModel: vi.fn(), withModelMutationLock: vi.fn() }));
let module: typeof import('./index-hosted');
let reader: ReturnType<typeof module.createReadOnlyLlamaCppClient>;

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); fixture.canReuse.mockReturnValue(true);
  fixture.prepareModel.mockResolvedValue(undefined);
  fixture.generate.mockResolvedValue({ content: 'text', reasoningContent: '', toolCalls: [], finishReason: 'stop' }); module = await import('./index-hosted');
  reader = module.createReadOnlyLlamaCppClient();
});

afterEach(async () => {
  await reader.dispose(); module.llamaCppBrowserService.release();
});

function input(): Parameters<LlamaCppBrowserService['generate']>[0]['input'] {
  return { model: 'local.gguf', messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, maxTokens: 8, presencePenalty: 0, frequencyPenalty: 0, stop: [], debug: 'on' };
}

it('uses existing files without probing writable storage and forces debugging off', async () => {
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  expect(fixture.probeProfiles).not.toHaveBeenCalled(); expect(fixture.resolve).toHaveBeenCalledOnce();
  expect(fixture.generate).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ debug: 'off', options: { profile: 'cpu-wasm32' } }) }));
});

it('keeps the shared lane reserved until cancelled physical work actually finishes', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerClient['generate']>>>(), stop = new AbortController();
  fixture.generate.mockReturnValueOnce(gate.promise);
  const first = reader.generate({ input: input(), signal: stop.signal, onEvent: () => {}, onProgress: () => {} });
  const rejected = expect(first).rejects.toBeDefined();
  await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledOnce()); stop.abort();
  await expect(reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('busy');
  gate.resolve({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' }); await rejected;
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} }); expect(fixture.generate).toHaveBeenCalledTimes(2);
});

it('does not create or probe a worker for a pre-cancelled call', async () => {
  const stop = new AbortController(); stop.abort();
  await expect(reader.generate({ input: input(), signal: stop.signal, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('aborted');
  expect(fixture.generate).not.toHaveBeenCalled(); expect(fixture.probeProfiles).not.toHaveBeenCalled();
});

it('local unscoped cancel and release cannot stop a read-only invocation, including its reservation gap', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerClient['generate']>>>();
  const controller = new AbortController(); fixture.generate.mockReturnValueOnce(gate.promise);
  const task = reader.generate({ input: input(), signal: controller.signal, onEvent: () => {}, onProgress: () => {} });
  const rejected = expect(task).rejects.toBeDefined();
  try {
    module.llamaCppBrowserService.cancel(); module.llamaCppBrowserService.release();
    await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledOnce());
    const nativeSignal = fixture.generate.mock.calls[0]![0].signal;
    if (!nativeSignal) throw new Error('Expected the owned signal.');
    module.llamaCppBrowserService.cancel(); module.llamaCppBrowserService.release();
    expect(nativeSignal.aborted).toBe(false); expect(fixture.dispose).not.toHaveBeenCalled();
    controller.abort(); expect(nativeSignal.aborted).toBe(true);
    module.llamaCppBrowserService.release(); expect(fixture.dispose).not.toHaveBeenCalled();
  } finally {
    gate.resolve({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' }); await rejected;
  }
  module.llamaCppBrowserService.release(); expect(fixture.dispose).toHaveBeenCalledOnce();
});

it('restart cannot acquire the shared worker while a read-only call is reserved but not yet running', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerClient['generate']>>>(); fixture.generate.mockReturnValueOnce(gate.promise);
  const task = reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  const restart = module.llamaCppBrowserService.restartRuntime({ signal: undefined });
  // Observe the rejection before releasing the invocation to avoid queue timing masking the race.
  const result = restart.then(() => 'restarted', error => error.message);
  await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledOnce());
  expect(fixture.dispose).not.toHaveBeenCalled();
  gate.resolve({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' }); await task;
  expect(await result).toBe('llama.cpp browser: busy'); expect(fixture.probeProfiles).not.toHaveBeenCalled();
});

it('retirement during profile resolution waits for the reserved operation and never starts inference', async () => {
  const profile = Promise.withResolvers<string>(); fixture.resolve.mockReturnValueOnce(profile.promise);
  const task = reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  const rejected = expect(task).rejects.toBeDefined();
  await vi.waitFor(() => expect(fixture.resolve).toHaveBeenCalledOnce());
  const closing = reader.dispose(); expect(reader.dispose()).toBe(closing);
  let retired = false; void closing.then(() => {
    retired = true;
  });
  await Promise.resolve(); expect(retired).toBe(false);
  profile.resolve('cpu-wasm32'); await rejected; await closing;
  expect(fixture.generate).not.toHaveBeenCalled(); expect(fixture.dispose).toHaveBeenCalledOnce();
  await expect(reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('aborted');
});

it('a capability probe does not take over the read-only model cache', async () => {
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  fixture.probeProfiles.mockResolvedValueOnce({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  await module.llamaCppBrowserService.probeProfiles({ signal: undefined });
  await reader.dispose(); expect(fixture.dispose).toHaveBeenCalledOnce();
  expect(module.llamaCppBrowserService.getProfileState()).toEqual({ status: 'idle' });
});

it('retirement failures remain failures and do not strand the shared operation lane', async () => {
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  fixture.dispose.mockImplementationOnce(() => {
    throw new Error('native disposal failed');
  });
  const closing = reader.dispose(); await expect(closing).rejects.toThrow('native disposal failed');
  expect(reader.dispose()).toBe(closing);
  const next = module.createReadOnlyLlamaCppClient();
  await next.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  reader = next;
  await next.dispose(); expect(fixture.generate).toHaveBeenCalledTimes(2);
});

it.each(['resolve', 'reject'] as const)('waits for asynchronous retirement to %s before admitting the next owner', async settlement => {
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  const disposal = Promise.withResolvers<void>();
  fixture.dispose.mockReturnValueOnce(disposal.promise);
  const closing = reader.dispose();
  const observed = closing.then(() => undefined, error => error);
  expect(reader.dispose()).toBe(closing);
  await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce());
  const next = module.createReadOnlyLlamaCppClient();
  await expect(next.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('busy');
  expect(fixture.generate).toHaveBeenCalledOnce();
  const failure = new Error('asynchronous native disposal failed');
  if (settlement === 'reject') disposal.reject(failure);
  else disposal.resolve();
  expect(await observed).toBe(settlement === 'reject' ? failure : undefined);
  expect(reader.dispose()).toBe(closing);
  await next.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  reader = next;
  await next.dispose();
  expect(fixture.generate).toHaveBeenCalledTimes(2);
});

it.each(['resolve', 'reject'] as const)('awaits detached retirement after cancellation until it can %s', async settlement => {
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  const generation = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerClient['generate']>>>();
  const disposal = Promise.withResolvers<void>();
  fixture.generate.mockReturnValueOnce(generation.promise);
  const generating = reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  const generated = expect(generating).rejects.toThrow('aborted');
  await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledTimes(2));
  fixture.canReuse.mockReturnValue(false);
  fixture.dispose.mockReturnValueOnce(disposal.promise);
  const closing = reader.dispose();
  let closed = false;
  const observed = closing.then(() => {
    closed = true;
  }, error => {
    closed = true;
    return error;
  });
  generation.reject(new DOMException('cancelled', 'AbortError'));
  await generated;
  await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce());
  await Promise.resolve(); await Promise.resolve();
  expect(closed).toBe(false);
  expect(reader.dispose()).toBe(closing);
  const failure = new Error('detached native disposal failed');
  if (settlement === 'reject') disposal.reject(failure);
  else disposal.resolve();
  expect(await observed).toBe(settlement === 'reject' ? failure : undefined);
  const next = module.createReadOnlyLlamaCppClient();
  fixture.canReuse.mockReturnValue(true);
  await next.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  reader = next;
});

it('does not await retirement belonging to a reader that took over the cache', async () => {
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  const next = module.createReadOnlyLlamaCppClient();
  await next.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  const disposal = Promise.withResolvers<void>();
  fixture.dispose.mockReturnValueOnce(disposal.promise);
  const closing = next.dispose();
  await vi.waitFor(() => expect(fixture.dispose).toHaveBeenCalledOnce());
  await reader.dispose();
  expect(fixture.dispose).toHaveBeenCalledOnce();
  disposal.resolve();
  await closing;
  reader = next;
});

it('does not queue completed detached retirement behind another reader operation', async () => {
  fixture.generate.mockRejectedValueOnce(new Error('generation failed'));
  await expect(reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('runtime-error');
  expect(fixture.dispose).toHaveBeenCalledOnce();
  const next = module.createReadOnlyLlamaCppClient();
  const generation = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerClient['generate']>>>();
  fixture.generate.mockReturnValueOnce(generation.promise);
  const generating = next.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledTimes(2));
  await reader.dispose();
  expect(fixture.dispose).toHaveBeenCalledOnce();
  generation.resolve({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
  await generating;
  reader = next;
});

it('does not start welcome warmup when an advisory probe is queued behind read-only generation', async () => {
  const generating = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerClient['generate']>>>();
  fixture.generate.mockReturnValueOnce(generating.promise);
  fixture.probeProfiles.mockResolvedValueOnce({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  const generation = reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  await vi.waitFor(() => expect(fixture.generate).toHaveBeenCalledOnce());
  const service = module.llamaCppBrowserService;
  const probe = service.probeProfiles({ signal: undefined });
  try {
    await expect(service.prepareModel({ model: 'welcome.gguf', signal: undefined })).resolves.toBe('skipped-busy');
    service.cancel(); service.release();
    expect(fixture.generate.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    expect(fixture.probeProfiles).not.toHaveBeenCalled();
    expect(fixture.prepareModel).not.toHaveBeenCalled();
    expect(fixture.dispose).not.toHaveBeenCalled();
  } finally {
    generating.resolve({ content: 'text', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await generation; await probe;
  }
  // The passive probe does not become the owner of the read-only model cache.
  await reader.dispose();
  expect(fixture.dispose).toHaveBeenCalledOnce();
  expect(service.getProfileState()).toEqual({ status: 'idle' });
});

it('preserves fail-fast read-only acceptance while an advisory probe owns the lane', async () => {
  const checking = Promise.withResolvers<ProfileCapabilities>();
  fixture.probeProfiles.mockReturnValueOnce(checking.promise);
  const probe = module.llamaCppBrowserService.probeProfiles({ signal: undefined });
  try {
    await expect(reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} })).rejects.toThrow('busy');
    expect(fixture.generate).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();
  } finally {
    checking.resolve({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
    await probe;
  }
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  expect(fixture.generate).toHaveBeenCalledOnce();
});

it('does not revive a retired read-only cache through warmup waiting on an advisory probe', async () => {
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  const checking = Promise.withResolvers<ProfileCapabilities>();
  fixture.probeProfiles.mockReturnValueOnce(checking.promise);
  const service = module.llamaCppBrowserService;
  const probe = service.probeProfiles({ signal: undefined });
  const preparing = service.prepareModel({ model: 'welcome.gguf', signal: undefined });
  const rejected = expect(preparing).rejects.toThrow('aborted');
  const retiring = reader.dispose();
  checking.resolve({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  await probe; await retiring; await rejected;
  expect(fixture.prepareModel).not.toHaveBeenCalled();
  expect(fixture.dispose).toHaveBeenCalledOnce();
  expect(service.getProfileState()).toEqual({ status: 'idle' });
});

it('transfers cache ownership to welcome warmup after a shared advisory probe', async () => {
  await reader.generate({ input: input(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
  const checking = Promise.withResolvers<ProfileCapabilities>();
  fixture.probeProfiles.mockReturnValueOnce(checking.promise);
  const service = module.llamaCppBrowserService;
  const probe = service.probeProfiles({ signal: undefined });
  const preparing = service.prepareModel({ model: 'welcome.gguf', signal: undefined });
  checking.resolve({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
  await probe; await expect(preparing).resolves.toBe('ready');
  expect(fixture.prepareModel).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining({ model: 'welcome.gguf' }) }));
  await reader.dispose();
  // The retired read-only owner must not evict a model now owned by the local UI.
  expect(fixture.dispose).not.toHaveBeenCalled();
  expect(service.getProfileState().status).toBe('ready');
});
