import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlamaCppBrowserError, type GenerateInput } from '@/features/llama-cpp-browser/types';
import { createLlamaCppWorkerClient } from './client-standalone';

const calls = vi.hoisted(() => ({ factory: vi.fn(), probe: vi.fn(), release: vi.fn(), remote: {
  listModels: vi.fn(), importModel: vi.fn(), importDirectory: vi.fn(), removeModel: vi.fn(), generate: vi.fn(), cancelGeneration: vi.fn(), release: vi.fn(), verifyStorage: vi.fn(),
} }));
vi.mock('virtual:file-protocol-standalone/worker/llama-cpp-browser', () => ({ createStandaloneWorker: calls.factory }));
vi.mock('../runtime/shared-storage-probe', () => ({ verifySharedStorage: calls.probe }));
vi.mock('@/utils/worker-transport', () => ({ wrapWorkerRemote: () => calls.remote, releaseWorkerRemote: calls.release, workerProxy: ({ value }: { value: unknown }) => value }));
class TestWorker extends EventTarget {
  terminate = vi.fn();
}
let worker: TestWorker;
function request(): GenerateInput {
  return { model: 'local.gguf', messages: [{ role: 'user', content: 'hello' }], temperature: 0, topP: 1, maxTokens: 3, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: 'webgpu-wasm64-jspi' } };
}
beforeEach(() => {
  vi.resetAllMocks(); worker = new TestWorker(); vi.stubGlobal('Worker', TestWorker);
  calls.factory.mockResolvedValue(worker); calls.probe.mockResolvedValue(undefined);
  calls.remote.listModels.mockResolvedValue([]); calls.remote.release.mockResolvedValue(undefined); calls.release.mockResolvedValue(undefined);
  calls.remote.generate.mockResolvedValue({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
});
describe('standalone llama Worker lifetime', () => {
  it('starts lazily once, checks shared OPFS, and sends no external runtime URL', async () => {
    const client = createLlamaCppWorkerClient();
    expect(calls.factory).not.toHaveBeenCalled();
    await client.listModels({ signal: undefined });
    await client.generate({ request: request(), onChunk: () => {}, onProgress: () => {}, signal: undefined });
    expect(calls.factory).toHaveBeenCalledOnce(); expect(calls.probe).toHaveBeenCalledOnce();
    const wire = calls.remote.generate.mock.calls[0]?.[0];
    expect(wire.options.profile).toBe('webgpu-wasm64-jspi');
    expect(wire.assetBaseURL).toBeUndefined();
    client.dispose(); client.dispose();
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    expect(calls.remote.release).toHaveBeenCalledOnce();
    expect(calls.release).toHaveBeenCalledOnce();
  });
  it.each(['auto', 'cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify'] as const)('rejects %s before creating the Worker', async profile => {
    const client = createLlamaCppWorkerClient();
    await expect(client.generate({ request: { ...request(), options: { profile } }, onChunk: () => {}, onProgress: () => {}, signal: undefined })).rejects.toThrow('unavailable');
    expect(calls.factory).not.toHaveBeenCalled(); client.dispose();
  });
  it('rejects promptly on disposal while startup is pending and terminates a late Worker', async () => {
    const startup = Promise.withResolvers<Worker>(); calls.factory.mockReturnValue(startup.promise);
    const client = createLlamaCppWorkerClient(); const pending = client.listModels({ signal: undefined });
    client.dispose(); await expect(pending).rejects.toThrow('worker-failed');
    startup.resolve(worker as unknown as Worker);
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    expect(calls.probe).not.toHaveBeenCalled();
  });
  it('preserves cancellation during startup and prevents a second operation from resurrecting the client', async () => {
    const startup = Promise.withResolvers<Worker>(); calls.factory.mockReturnValue(startup.promise);
    const client = createLlamaCppWorkerClient(); const controller = new AbortController();
    const pending = client.listModels({ signal: controller.signal }); controller.abort();
    await expect(pending).rejects.toThrow('aborted');
    expect(client.canReuse()).toBe(false);
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('worker-failed');
    startup.resolve(worker as unknown as Worker);
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  });
  it('reports actual storage unavailability instead of losing it to the disposal race', async () => {
    calls.probe.mockRejectedValue(new LlamaCppBrowserError({ code: 'unavailable' }));
    const client = createLlamaCppWorkerClient();
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('unavailable');
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    expect(calls.remote.listModels).not.toHaveBeenCalled();
  });
  it('reports a missing Worker capability as unavailable without invoking its factory', async () => {
    vi.stubGlobal('Worker', undefined);
    const client = createLlamaCppWorkerClient();
    await expect(client.listModels({ signal: undefined })).rejects.toThrow('unavailable');
    expect(calls.factory).not.toHaveBeenCalled();
  });
  it('bounds native cleanup and Comlink release even when both stop responding', async () => {
    vi.useFakeTimers();
    calls.remote.release.mockImplementation(() => new Promise(() => {})); calls.release.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); await client.listModels({ signal: undefined });
    client.dispose();
    await vi.advanceTimersByTimeAsync(6000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('rejects a running operation immediately and skips native cleanup on a failed Worker', async () => {
    calls.remote.listModels.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const operation = client.listModels({ signal: undefined });
    const rejection = expect(operation).rejects.toThrow('worker-failed');
    await vi.waitFor(() => expect(calls.remote.listModels).toHaveBeenCalled());
    worker.dispatchEvent(new ErrorEvent('error', { message: 'private native details', cancelable: true }));
    await rejection; await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    expect(calls.remote.release).not.toHaveBeenCalled();
  });
});
