import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LlamaCppWorkerClient } from './worker/types';
import type { LlamaCppBrowserService } from './service-contract';
const fixture = vi.hoisted(() => ({
  generate: vi.fn<LlamaCppWorkerClient['generate']>(),
  probeProfiles: vi.fn(),
  dispose: vi.fn(),
  subscribeDisposed: vi.fn(() => () => {}),
  canReuse: vi.fn(() => true),
  resolve: vi.fn(async () => 'cpu-wasm32'),
}));
vi.mock('@/features/llama-cpp-browser/worker/client', () => ({ createLlamaCppWorkerClient: () => fixture }));
vi.mock('@/features/llama-cpp-browser/runtime/detect-profile', () => ({ resolveRuntimeProfile: fixture.resolve }));
vi.mock('@/features/llama-cpp-browser/runtime/model-store', () => ({ listStoredModels: vi.fn(async () => []), removeStoredModel: vi.fn(), withModelMutationLock: vi.fn() }));
let module: typeof import('./index-hosted');
let reader: ReturnType<typeof module.createReadOnlyLlamaCppClient>;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); fixture.canReuse.mockReturnValue(true);
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
