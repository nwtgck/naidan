import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlamaCppBrowserError, type GenerateInput } from '@/features/llama-cpp-browser/types';
import { createLlamaCppWorkerClient } from './client-hosted';
const transport = vi.hoisted(() => ({ remote: { listModels: vi.fn(), importModel: vi.fn(), removeModel: vi.fn(), generate: vi.fn(), cancelGeneration: vi.fn() }, release: vi.fn() }));
vi.mock('@/utils/worker-transport', () => ({ wrapWorkerRemote: () => transport.remote,
  releaseWorkerRemote: transport.release, workerProxy: ({ value }: { value: unknown }) => value }));
class TestWorker extends EventTarget {
  static instances: TestWorker[] = [];
  terminate = vi.fn();
  constructor() {
    super(); TestWorker.instances.push(this);
  }
}
beforeEach(() => {
  vi.clearAllMocks(); TestWorker.instances = [];
  vi.stubGlobal('Worker', TestWorker);
  transport.remote.listModels.mockResolvedValue([]);
  transport.remote.cancelGeneration.mockResolvedValue(undefined);
  transport.remote.generate.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.useRealTimers();
});
describe('hosted Worker lifetime', () => {
  it('does not construct a Worker when the platform has no Worker support', async () => {
    vi.stubGlobal('Worker', undefined);
    const client = createLlamaCppWorkerClient();
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('unavailable');
    expect(TestWorker.instances).toHaveLength(0);
    client.dispose();
  });
  it('rejects a pending call immediately when its signal aborts and terminates the Worker once', async () => {
    transport.remote.listModels.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const controller = new AbortController();
    const pending = client.listModels({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(TestWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    expect(transport.release).toHaveBeenCalledOnce();
    client.dispose();
    expect(TestWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('worker-failed');
  });
  it('rejects pending work on a Worker error without exposing the native error message', async () => {
    transport.remote.listModels.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const pending = client.listModels({ signal: undefined });
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'private prompt and path', cancelable: true }));
    await expect(pending).rejects.toThrow('llama.cpp browser: worker-failed');
    expect(TestWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });
  it('rejects overlapping operations instead of sharing unsafe native state', async () => {
    transport.remote.listModels.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const first = client.listModels({ signal: undefined });
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('busy');
    client.dispose(); await expect(first).rejects.toThrow('worker-failed');
  });
  it('validates model inventory received from the Worker', async () => {
    transport.remote.listModels.mockResolvedValue([{ id: 'not-a-uuid', name: 'private.gguf', size: 1, importedAt: 0 }]);
    const client = createLlamaCppWorkerClient();
    await expect(client.listModels({ signal: undefined })).rejects.toThrow();
    client.dispose();
  });
});

function generationInput(): GenerateInput {
  return { model: 'local.gguf', messages: [{ role: 'user', content: 'private prompt' }], temperature: 0,
    topP: 1, maxTokens: 5, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: 'cpu-wasm32', contextSize: 256 } };
}
describe('cooperative generation cancellation', () => {
  it('waits for native cleanup, preserves the Worker, and suppresses cancelled or late events', async () => {
    let finish: () => void = () => {};
    transport.remote.generate.mockImplementationOnce(() => new Promise<void>(resolve => {
      finish = resolve;
    }));
    const controller = new AbortController(); const chunk = vi.fn(); const progress = vi.fn();
    const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: generationInput(), onChunk: chunk, onProgress: progress, signal: controller.signal });
    const rejectCheck = expect(pending).rejects.toThrow('aborted');
    const call = transport.remote.generate.mock.calls[0]!;
    const onChunk = call[1] as ({ text }: { text: string }) => void;
    const onProgress = call[2] as ({ phase, completed, total }: { phase: string, completed: number, total: number }) => void;
    controller.abort();
    expect(transport.remote.cancelGeneration).toHaveBeenCalledWith({ generationId: 1 });
    expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
    onChunk({ text: 'private trailing content' }); onProgress({ phase: 'loading', completed: 1, total: 1 });
    finish(); await rejectCheck;
    expect(client.canReuse()).toBe(true); expect(chunk).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
    transport.remote.generate.mockResolvedValueOnce(undefined);
    await client.generate({ request: generationInput(), onChunk: chunk, onProgress: progress, signal: undefined });
    expect(transport.remote.generate.mock.calls[1]?.[0].generationId).toBe(2);
    onProgress({ phase: 'loading', completed: 1, total: 1 }); expect(progress).not.toHaveBeenCalled();
    expect(TestWorker.instances).toHaveLength(1); client.dispose();
  });
  it('terminates a Worker only when cooperative cancellation does not settle within the grace period', async () => {
    vi.useFakeTimers();
    transport.remote.generate.mockImplementationOnce(() => new Promise<void>(() => {}));
    const controller = new AbortController(); const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: generationInput(), onChunk: () => {}, onProgress: () => {}, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('aborted');
    controller.abort(); await vi.advanceTimersByTimeAsync(4999);
    expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(TestWorker.instances[0]?.terminate).toHaveBeenCalledOnce(); expect(client.canReuse()).toBe(false);
  });
  it('resets a Worker on a cancellation transport failure', async () => {
    transport.remote.generate.mockImplementationOnce(() => new Promise<void>(() => {}));
    transport.remote.cancelGeneration.mockRejectedValueOnce(new Error('private transport detail'));
    const controller = new AbortController(); const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: generationInput(), onChunk: () => {}, onProgress: () => {}, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('aborted');
    controller.abort(); await rejected; expect(client.canReuse()).toBe(false);
  });
  it('preserves the Worker after a cooperatively aborted native request', async () => {
    transport.remote.generate.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'aborted' }));
    const client = createLlamaCppWorkerClient();
    await expect(client.generate({ request: generationInput(), onChunk: () => {}, onProgress: () => {}, signal: undefined })).rejects.toThrow('aborted');
    expect(client.canReuse()).toBe(true); client.dispose();
  });
});
