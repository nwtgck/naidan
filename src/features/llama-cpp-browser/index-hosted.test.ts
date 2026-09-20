import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlamaCppWorkerClient } from './worker/types';
import { LlamaCppBrowserError, type GenerationResult } from './types';
import type { LlamaCppBrowserService } from './service-contract';
const worker = vi.hoisted(() => ({ listModels: vi.fn<LlamaCppWorkerClient['listModels']>(), importModel: vi.fn<LlamaCppWorkerClient['importModel']>(), removeModel: vi.fn<LlamaCppWorkerClient['removeModel']>(), generate: vi.fn<LlamaCppWorkerClient['generate']>(), canReuse: vi.fn(() => true), dispose: vi.fn() }));
const factory = vi.hoisted(() => vi.fn(() => worker));
vi.mock('@/features/llama-cpp-browser/worker/client', () => ({ createLlamaCppWorkerClient: factory }));
let service: LlamaCppBrowserService;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  worker.canReuse.mockReturnValue(true);
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
    expect(service.getOptions()).toEqual({ profile: 'auto', contextSize: 4096 });
  });
  it('snapshots inputs and options before entering the single Worker lane', async () => {
    let finish: () => void = () => {};
    worker.generate.mockImplementationOnce(() => new Promise<GenerationResult>(resolve => {
      finish = () => resolve({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    }));
    const first = service.generate({ input: input(), onChunk: () => {}, signal: undefined });
    await vi.waitFor(() => expect(worker.generate).toHaveBeenCalledOnce());
    service.setOptions({ options: { profile: 'cpu-wasm32', contextSize: 256 } });
    const pendingInput = input(); const second = service.generate({ input: pendingInput, onChunk: () => {}, signal: undefined });
    pendingInput.messages[0]!.content = 'mutated';
    service.setOptions({ options: { profile: 'cpu-wasm64', contextSize: 512 } });
    expect(worker.generate).toHaveBeenCalledOnce();
    finish(); await first; await second;
    expect(worker.generate).toHaveBeenCalledTimes(2);
    expect(worker.generate.mock.calls[1]?.[0].request.messages).toEqual([{ role: 'user', content: 'original' }]);
    expect(worker.generate.mock.calls[1]?.[0].request.options).toEqual({ profile: 'cpu-wasm32', contextSize: 256 });
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
    expect(factory).toHaveBeenCalledTimes(2);
    expect(service.getState()).toEqual({ status: 'idle' });
  });
  it('does not let a model-list observer turn a completed deletion into a storage failure', async () => {
    worker.removeModel.mockResolvedValue();
    const unsubscribe = service.subscribeModelList({ listener: () => {
      throw new Error('private observer details');
    } });
    await expect(service.removeModel({ id: 'user/local-GGUF/local.gguf', signal: undefined })).resolves.toBeUndefined();
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
    worker.canReuse.mockReturnValue(false); worker.generate.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'aborted' }));
    await expect(service.generate({ input: input(), onChunk: () => {}, signal: undefined })).rejects.toThrow('aborted');
    expect(worker.dispose).toHaveBeenCalledOnce();
    worker.canReuse.mockReturnValue(true); await service.generate({ input: input(), onChunk: () => {}, signal: undefined });
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
    const second = service.listModels({ signal: undefined });
    expect(worker.listModels).not.toHaveBeenCalled();
    finish(); await first; await second;
    expect(worker.generate).toHaveBeenCalledTimes(2);
    expect(worker.listModels).toHaveBeenCalledOnce();
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
    const second = service.listModels({ signal: undefined });
    expect(worker.listModels).not.toHaveBeenCalled();
    releaseTool(); await rejected; await second;
    expect(worker.generate).toHaveBeenCalledOnce(); expect(worker.listModels).toHaveBeenCalledOnce();
  });
});
