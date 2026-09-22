import { listStoredModels, removeStoredModel } from './runtime/model-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlamaCppWorkerClient } from './worker/types';
import { LlamaCppBrowserError, type GenerationResult } from './types';
import type { LlamaCppBrowserService } from './service-contract';
const worker = vi.hoisted(() => ({ subscribeDisposed: vi.fn<LlamaCppWorkerClient['subscribeDisposed']>(), probeProfiles: vi.fn<LlamaCppWorkerClient['probeProfiles']>(), listModels: vi.fn<LlamaCppWorkerClient['listModels']>(), importModel: vi.fn<LlamaCppWorkerClient['importModel']>(), removeModel: vi.fn<LlamaCppWorkerClient['removeModel']>(), generate: vi.fn<LlamaCppWorkerClient['generate']>(), canReuse: vi.fn(() => true), dispose: vi.fn() }));
const factory = vi.hoisted(() => vi.fn(() => worker));
vi.mock('@/features/llama-cpp-browser/worker/client', () => ({ createLlamaCppWorkerClient: factory }));
vi.mock('./runtime/model-store', () => ({ listStoredModels: vi.fn(), removeStoredModel: vi.fn(), withModelMutationLock: ({ operation }: { operation: () => Promise<unknown> }) => operation() }));
let service: LlamaCppBrowserService;
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  worker.subscribeDisposed.mockReturnValue(() => {});
  worker.probeProfiles.mockResolvedValue({ recommended: 'cpu-wasm32', profiles: [
    { profile: 'cpu-wasm32', status: 'available' }, { profile: 'cpu-wasm64', status: 'available' },
  ] });
  worker.canReuse.mockReturnValue(true); vi.mocked(listStoredModels).mockResolvedValue([]); vi.mocked(removeStoredModel).mockResolvedValue('deleted');
  worker.listModels.mockResolvedValue([]); worker.generate.mockResolvedValue({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
  service = (await import('./index-hosted')).llamaCppBrowserService;
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  service.release(); vi.restoreAllMocks();
});
function input(): Parameters<LlamaCppBrowserService['generate']>[0]['input'] {
  return { model: 'local.gguf', messages: [{ role: 'user', content: 'original' }], temperature: 0, topP: 1,
    maxTokens: 5, presencePenalty: 0, frequencyPenalty: 0, stop: [] };
}
describe('serialized hosted model service', () => {
  it('defaults to browser feature detection without an explicitly chosen profile', () => {
    expect(service.getOptions()).toEqual({ profile: 'auto' });
  });
  it('resolves auto on the same Worker before passing a concrete generation profile', async () => {
    await service.probeProfiles({ signal: undefined });
    await service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    expect(worker.probeProfiles).toHaveBeenCalledOnce();
    expect(worker.generate.mock.calls[0]?.[0].request.options.profile).toBe('cpu-wasm32');
    expect(factory).toHaveBeenCalledOnce();
  });
  it('cancels only a UI observer and preserves the shared Worker and probe result', async () => {
    const gate = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerClient['probeProfiles']>>>();
    worker.probeProfiles.mockReturnValueOnce(gate.promise);
    const controller = new AbortController();
    const observer = service.probeProfiles({ signal: controller.signal });
    await vi.waitFor(() => expect(worker.probeProfiles).toHaveBeenCalledOnce());
    controller.abort(); await expect(observer).rejects.toThrow('aborted');
    expect(worker.dispose).not.toHaveBeenCalled();
    expect(worker.probeProfiles).toHaveBeenCalledWith({ signal: undefined });
    gate.resolve({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
    await vi.waitFor(() => expect(service.getProfileState().status).toBe('ready'));
    await service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    expect(worker.probeProfiles).toHaveBeenCalledOnce();
  });
  it('invalidates reported capabilities when the Worker is disposed and probes its replacement', async () => {
    await service.probeProfiles({ signal: undefined });
    expect(service.getProfileState().status).toBe('ready');
    worker.subscribeDisposed.mock.calls[0]?.[0].listener();
    expect(service.getProfileState()).toEqual({ status: 'idle' });
    await service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    expect(factory).toHaveBeenCalledTimes(2); expect(worker.probeProfiles).toHaveBeenCalledTimes(2);
  });
  it('does not start inference or silently substitute an unavailable explicit profile', async () => {
    service.setOptions({ options: { profile: 'webgpu-wasm32-jspi' } });
    await expect(service.generate({ input: input(), onChunk: () => {}, signal: undefined })).rejects.toThrow('unavailable');
    expect(worker.generate).not.toHaveBeenCalled();
  });
  it('keeps a terminal probe failure visible and retries only when explicitly requested', async () => {
    worker.probeProfiles.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'worker-failed' }));
    await expect(service.probeProfiles({ signal: undefined })).rejects.toThrow('worker-failed');
    expect(service.getProfileState()).toEqual({ status: 'error', code: 'worker-failed' });
    expect(service.getState()).toEqual({ status: 'idle' });
    expect(worker.probeProfiles).toHaveBeenCalledOnce();
    await service.probeProfiles({ signal: undefined });
    expect(service.getProfileState().status).toBe('ready');
    expect(factory).toHaveBeenCalledTimes(2);
  });
  it('does not clear an unrelated model-operation error when inspecting capabilities', async () => {
    worker.importModel.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'invalid-gguf' }));
    await expect(service.importModel({ file: new File([], 'invalid.gguf'), signal: undefined })).rejects.toThrow('invalid-gguf');
    await service.probeProfiles({ signal: undefined });
    expect(service.getState()).toEqual({ status: 'error', code: 'invalid-gguf' });
  });
  it('does not reuse or publish a released probe and retains the newer pending probe', async () => {
    const old = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerClient['probeProfiles']>>>();
    const fresh = Promise.withResolvers<Awaited<ReturnType<LlamaCppWorkerClient['probeProfiles']>>>();
    worker.probeProfiles.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = service.probeProfiles({ signal: undefined });
    const failed = expect(first).rejects.toThrow('worker-failed');
    await vi.waitFor(() => expect(worker.probeProfiles).toHaveBeenCalledOnce());
    service.release();
    const second = service.probeProfiles({ signal: undefined });
    old.resolve({ recommended: 'cpu-wasm64', profiles: [{ profile: 'cpu-wasm64', status: 'available' }] });
    await failed;
    await vi.waitFor(() => expect(worker.probeProfiles).toHaveBeenCalledTimes(2));
    const third = service.probeProfiles({ signal: undefined });
    fresh.resolve({ recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] });
    await second; await third;
    expect(worker.probeProfiles).toHaveBeenCalledTimes(2);
    expect(service.getProfileState()).toMatchObject({ status: 'ready', capabilities: { recommended: 'cpu-wasm32' } });
  });
  it('returns a cached report while generation owns the Worker lane', async () => {
    const gate = Promise.withResolvers<GenerationResult>(); worker.generate.mockReturnValueOnce(gate.promise);
    const generating = service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    await vi.waitFor(() => expect(worker.generate).toHaveBeenCalledOnce());
    await expect(service.probeProfiles({ signal: undefined })).resolves.toMatchObject({ recommended: 'cpu-wasm32' });
    expect(worker.probeProfiles).toHaveBeenCalledOnce(); expect(service.getState().status).toBe('working');
    gate.resolve({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' }); await generating;
  });
  it('snapshots inputs and options before entering the single Worker lane', async () => {
    let finish: () => void = () => {};
    worker.generate.mockImplementationOnce(() => new Promise<GenerationResult>(resolve => {
      finish = () => resolve({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    }));
    const first = service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    await vi.waitFor(() => expect(worker.generate).toHaveBeenCalledOnce());
    service.setOptions({ options: { profile: 'cpu-wasm32' } });
    const pendingInput = input(); const second = service.generate({ input: pendingInput, onChunk: () => {}, signal: undefined });
    pendingInput.messages[0]!.content = 'mutated';
    service.setOptions({ options: { profile: 'cpu-wasm64' } });
    expect(worker.generate).toHaveBeenCalledOnce();
    finish(); await first; await second;
    expect(worker.generate).toHaveBeenCalledTimes(2);
    expect(worker.generate.mock.calls[1]?.[0].request.messages).toEqual([{ role: 'user', content: 'original' }]);
    expect(worker.generate.mock.calls[1]?.[0].request.options).toEqual({ profile: 'cpu-wasm32' });
    expect(factory).toHaveBeenCalledOnce();
  });
  it('does not run a cancelled queued request and continues the lane afterward', async () => {
    let finish: () => void = () => {};
    worker.generate.mockImplementationOnce(() => new Promise<GenerationResult>(resolve => {
      finish = () => resolve({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    }));
    const first = service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    await vi.waitFor(() => expect(worker.generate).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const second = service.generate({ input: input(), onChunk: () => {}, signal: controller.signal });
    controller.abort(); finish(); await first;
    await expect(second).rejects.toThrow('aborted');
    expect(worker.generate).toHaveBeenCalledOnce();
    expect(await service.listModels({ signal: undefined })).toEqual([]);
  });
  it('terminates failed runtime ownership and exposes only a safe error code', async () => {
    worker.generate.mockRejectedValueOnce(new Error('private prompt, private file and native details'));
    await expect(service.generate({ input: input(), onChunk: () => {}, signal: undefined })).rejects.toThrow('llama.cpp browser: runtime-error');
    expect(service.getState()).toEqual({ status: 'error', code: 'runtime-error' });
    expect(worker.dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.debug).mock.calls)).not.toContain('private');
    await service.listModels({ signal: undefined });
    expect(factory).toHaveBeenCalledOnce();
    expect(service.getState()).toEqual({ status: 'error', code: 'runtime-error' });
  });
  it('lists and deletes storage without waiting for an active inference request', async () => {
    const gate = Promise.withResolvers<GenerationResult>(); worker.generate.mockImplementationOnce(() => gate.promise);
    const generating = service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    await vi.waitFor(() => expect(worker.generate).toHaveBeenCalledOnce());
    expect(await service.listModels({ signal: undefined })).toEqual([]);
    const plan = { id: 'hf.co/owner/repo:Model-Q4.gguf', files: [] };
    expect(await service.removeModel({ plan, signal: undefined })).toBe('deleted');
    expect(removeStoredModel).toHaveBeenCalledWith({ plan }); expect(worker.removeModel).not.toHaveBeenCalled(); expect(worker.dispose).not.toHaveBeenCalled();
    gate.resolve({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' }); await generating;
  });
  it('does not let a model-list observer turn a completed deletion into a storage failure', async () => {
    worker.removeModel.mockResolvedValue('deleted');
    const unsubscribe = service.subscribeModelList({ listener: () => {
      throw new Error('private observer details');
    } });
    await expect(service.removeModel({ plan: { id: 'user/local-GGUF', files: [] }, signal: undefined })).resolves.toBe('deleted');
    expect(worker.dispose).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({ status: 'idle' });
    expect(JSON.stringify(vi.mocked(console.debug).mock.calls)).not.toContain('private observer');
    unsubscribe();
  });
});

describe('resident Worker reuse at the service boundary', () => {
  it('keeps a cleanly cancelled Worker and does not claim to reload on every request', async () => {
    worker.generate.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'aborted' }));
    const states: string[] = [];
    const stop = service.subscribe({ listener: ({ state }) => {
      if (state.status === 'working') states.push(state.progress.phase);
    } });
    await expect(service.generate({ input: input(), onChunk: () => {}, signal: undefined })).rejects.toThrow('aborted');
    expect(worker.dispose).not.toHaveBeenCalled(); expect(service.getState()).toEqual({ status: 'idle' });
    await service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    expect(factory).toHaveBeenCalledOnce(); expect(states).toEqual(['prefill', 'prefill']); stop();
  });
  it('recreates a physically terminated Worker after cancellation timeout', async () => {
    worker.generate.mockImplementationOnce(async () => {
      worker.canReuse.mockReturnValue(false);
      throw new LlamaCppBrowserError({ code: 'aborted' });
    });
    await expect(service.generate({ input: input(), onChunk: () => {}, signal: undefined })).rejects.toThrow('aborted');
    expect(worker.dispose).toHaveBeenCalledOnce();
    worker.canReuse.mockReturnValue(true);
    await service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    expect(factory).toHaveBeenCalledTimes(2);
  });
  it('keeps weights after a prompt exceeds the allocated context', async () => {
    worker.generate.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'context-full' }));
    await expect(service.generate({ input: input(), onChunk: () => {}, signal: undefined })).rejects.toThrow('context-full');
    await service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    expect(worker.dispose).not.toHaveBeenCalled(); expect(factory).toHaveBeenCalledOnce();
  });
});

describe('tool work holds the generation lane', () => {
  it('keeps queued requests behind tool completion and the following model turn', async () => {
    let finish: () => void = () => {};
    const blocked = new Promise<void>(resolve => {
      finish = resolve;
    });
    let turns = 0;
    const first = service.generate({ input: input(), onChunk: () => {}, signal: undefined,
      onResult: async () => {
        if (turns++ === 0) {
          await blocked; return input();
        }
        return undefined;
      },
    });
    await vi.waitFor(() => expect(turns).toBe(1));
    const second = service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    expect(worker.generate).toHaveBeenCalledOnce();
    finish(); await first; await second;
    expect(worker.generate).toHaveBeenCalledTimes(3);
  });
  it('service cancellation reaches tool work and waits for it to settle before accepting the next request', async () => {
    let releaseTool: () => void = () => {};
    const blocked = new Promise<void>(resolve => {
      releaseTool = resolve;
    });
    let toolSignal: AbortSignal | undefined;
    const first = service.generate({ input: input(), onChunk: () => {}, signal: undefined,
      onResult: async ({ signal }) => {
        toolSignal = signal; await blocked; return input();
      },
    });
    const rejected = expect(first).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(toolSignal).toBeDefined());
    service.cancel(); expect(toolSignal?.aborted).toBe(true);
    const second = service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    expect(worker.generate).toHaveBeenCalledOnce();
    releaseTool(); await rejected; await second;
    expect(worker.generate).toHaveBeenCalledTimes(2);
  });
});
