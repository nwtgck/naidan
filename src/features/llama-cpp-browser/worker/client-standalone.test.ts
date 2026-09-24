import { createAudioPreviewRequests } from '@/features/audio-generation/preview-requests';
import { audioResult } from '@/features/audio-generation/test-utils/wav';
import { defaultAudioParameters } from '@/features/audio-generation/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlamaCppBrowserError, type GenerateInput } from '@/features/llama-cpp-browser/types';
import { createLlamaCppWorkerClient } from './client-standalone';

const calls = vi.hoisted(() => ({ factory: vi.fn(), probe: vi.fn(), release: vi.fn(), remote: {
  requestAudioPreview: vi.fn(async () => {}), finishAudioGeneration: vi.fn(), generateAudio: vi.fn(), probeProfiles: vi.fn(), listModels: vi.fn(), importModel: vi.fn(), importDirectory: vi.fn(), removeModel: vi.fn(), generate: vi.fn(), cancelGeneration: vi.fn(), release: vi.fn(), verifyStorage: vi.fn(),
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
  calls.remote.finishAudioGeneration.mockResolvedValue(undefined); calls.remote.generateAudio.mockResolvedValue(audioResult()); calls.remote.listModels.mockResolvedValue([]); calls.remote.release.mockResolvedValue(undefined); calls.release.mockResolvedValue(undefined);
  calls.remote.generate.mockResolvedValue({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
});
describe('standalone llama Worker lifetime', () => {
  it('probes capabilities through the actual initialized Worker and propagates its disposal', async () => {
    const report = { recommended: 'webgpu-wasm32-jspi', profiles: [{ profile: 'webgpu-wasm32-jspi', status: 'available' }] };
    calls.remote.probeProfiles.mockResolvedValueOnce(report);
    const client = createLlamaCppWorkerClient(); const disposed = vi.fn(); client.subscribeDisposed({ listener: disposed });
    await expect(client.probeProfiles({ signal: undefined })).resolves.toEqual(report);
    expect(calls.factory).toHaveBeenCalledOnce(); expect(calls.probe).toHaveBeenCalledOnce(); expect(calls.remote.generate).not.toHaveBeenCalled();
    worker.dispatchEvent(new ErrorEvent('error', { cancelable: true }));
    expect(disposed).toHaveBeenCalledOnce(); expect(client.canReuse()).toBe(false);
    await expect(client.probeProfiles({ signal: undefined })).rejects.toThrow('worker-failed');
    expect(calls.factory).toHaveBeenCalledOnce();
  });
  it('starts lazily once, checks shared OPFS, and sends no external runtime URL', async () => {
    const client = createLlamaCppWorkerClient();
    expect(calls.factory).not.toHaveBeenCalled();
    await client.listModels({ signal: undefined });
    await client.generate({ request: request(), onEvent: () => {}, onProgress: () => {}, signal: undefined });
    expect(calls.factory).toHaveBeenCalledOnce(); expect(calls.probe).toHaveBeenCalledOnce();
    const wire = calls.remote.generate.mock.calls[0]?.[0];
    expect(wire.options.profile).toBe('webgpu-wasm64-jspi');
    expect(wire.assetBaseURL).toBeUndefined();
    client.dispose(); client.dispose();
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    expect(calls.remote.release).toHaveBeenCalledOnce();
    expect(calls.release).toHaveBeenCalledOnce();
  });
  it.each(['cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-asyncify'] as const)('rejects %s before creating the Worker', async profile => {
    const client = createLlamaCppWorkerClient();
    await expect(client.generate({ request: { ...request(), options: { profile } }, onEvent: () => {}, onProgress: () => {}, signal: undefined })).rejects.toThrow('unavailable');
    expect(calls.factory).not.toHaveBeenCalled(); client.dispose();
  });
  it.each(['webgpu-wasm32-jspi'] as const)('forwards %s for capability resolution inside the Worker without an asset URL', async profile => {
    const client = createLlamaCppWorkerClient();
    await client.generate({ request: { ...request(), options: { profile } }, onEvent: () => {}, onProgress: () => {}, signal: undefined });
    const wire = calls.remote.generate.mock.calls[0]?.[0];
    expect(wire.options.profile).toBe(profile); expect(wire.assetBaseURL).toBeUndefined();
    client.dispose();
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  });
  it('rejects unresolved auto at the generation wire boundary', async () => {
    const client = createLlamaCppWorkerClient();
    await expect(client.generate({ request: { ...request(), options: { profile: 'auto' } }, onEvent: () => {}, onProgress: () => {}, signal: undefined })).rejects.toThrow();
    expect(calls.remote.generate).not.toHaveBeenCalled(); client.dispose();
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

describe('standalone single-file import cancellation', () => {
  it('uses cooperative rollback after startup and reuses the worker for the next import', async () => {
    const rollback = Promise.withResolvers<never>(); const file = new File(['fixture'], 'same.gguf');
    calls.remote.importModel.mockReturnValueOnce(rollback.promise);
    calls.remote.cancelGeneration.mockResolvedValue(undefined);
    const client = createLlamaCppWorkerClient(); const controller = new AbortController();
    const pending = client.importModel({ file, signal: controller.signal, onProgress: () => {} });
    const rejected = expect(pending).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(calls.remote.importModel).toHaveBeenCalledOnce());
    const generationId = calls.remote.importModel.mock.calls[0]?.[0].generationId;
    controller.abort();
    expect(calls.remote.cancelGeneration).toHaveBeenCalledWith({ generationId });
    expect(worker.terminate).not.toHaveBeenCalled(); expect(calls.remote.release).not.toHaveBeenCalled();
    rollback.reject(new LlamaCppBrowserError({ code: 'aborted' })); await rejected;
    expect(client.canReuse()).toBe(true);
    const model = { id: 'user/same-GGUF', name: 'same-GGUF', size: 7, importedAt: 1 };
    calls.remote.importModel.mockResolvedValueOnce(model);
    await expect(client.importModel({ file, signal: undefined, onProgress: () => {} })).resolves.toEqual(model);
    expect(calls.factory).toHaveBeenCalledOnce(); client.dispose();
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
  });
});

it('lazily verifies shared storage before dispatching standalone audio', async () => {
  const client = createLlamaCppWorkerClient(); expect(calls.factory).not.toHaveBeenCalled();
  const result = await client.generateAudio({ request: { ...defaultAudioParameters(), model: 'user/voice', text: 'Hello', debug: 'off', options: { profile: 'webgpu-wasm64-jspi' } }, onProgress: () => {}, cancellationSignal: undefined });
  expect(calls.factory).toHaveBeenCalledOnce(); expect(calls.probe).toHaveBeenCalledOnce();
  expect(calls.remote.generateAudio).toHaveBeenCalledOnce(); expect(calls.remote.generate).not.toHaveBeenCalled(); expect(result).toEqual(audioResult()); client.dispose();
});


it('forwards an early finish through lazy standalone initialization without loading another runtime', async () => {
  const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); calls.remote.generateAudio.mockReturnValueOnce(gate.promise);
  const client = createLlamaCppWorkerClient(); const finish = new AbortController();
  const pending = client.generateAudio({ request: { ...defaultAudioParameters(), text: 'Hello', model: 'user/voice', debug: 'off', options: { profile: 'webgpu-wasm64-jspi' } }, onProgress: () => {}, cancellationSignal: undefined, completionSignal: finish.signal });
  finish.abort(); await vi.waitFor(() => expect(calls.remote.finishAudioGeneration).toHaveBeenCalledExactlyOnceWith({ generationId: 1 }));
  expect(calls.remote.cancelGeneration).not.toHaveBeenCalled(); expect(worker.terminate).not.toHaveBeenCalled();
  expect(calls.factory).toHaveBeenCalledOnce(); expect(calls.remote.generateAudio.mock.calls[0]?.[0].assetBaseURL).toBeUndefined();
  gate.resolve({ ...audioResult(), finishReason: 'user-stop' }); expect(await pending).toMatchObject({ finishReason: 'user-stop' }); client.dispose();
});


it('retains preview intent across lazy standalone initialization without choosing extra runtime profiles', async () => {
  const initialization = Promise.withResolvers<Worker>(); calls.factory.mockReturnValueOnce(initialization.promise);
  const result = Promise.withResolvers<ReturnType<typeof audioResult>>(); calls.remote.generateAudio.mockReturnValueOnce(result.promise);
  const client = createLlamaCppWorkerClient(); const captures = createAudioPreviewRequests();
  const pending = client.generateAudio({ request: { ...defaultAudioParameters(), model: 'user/voice', text: 'Hello', debug: 'off', options: { profile: 'webgpu-wasm32-jspi' } }, cancellationSignal: undefined, onProgress: () => {}, preview: { requests: captures.requests, onPreview: () => {} } });
  captures.request(); expect(calls.remote.requestAudioPreview).not.toHaveBeenCalled();
  initialization.resolve(worker as unknown as Worker);
  await vi.waitFor(() => expect(calls.remote.requestAudioPreview).toHaveBeenCalledOnce());
  expect(calls.remote.requestAudioPreview).toHaveBeenCalledWith({ generationId: 1, requestVersion: 1 });
  expect(calls.remote.generateAudio.mock.calls[0]![0].options.profile).toBe('webgpu-wasm32-jspi');
  expect(calls.remote.generateAudio.mock.calls[0]![0].assetBaseURL).toBeUndefined();
  result.resolve(audioResult()); await pending; client.dispose();
});
