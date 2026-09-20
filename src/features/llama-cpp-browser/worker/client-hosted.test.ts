import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlamaCppBrowserError, type GenerateInput } from '@/features/llama-cpp-browser/types';
import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { createLlamaCppWorkerClient } from './client-hosted';
const transport = vi.hoisted(() => ({ remote: { listModels: vi.fn(), importModel: vi.fn(), importDirectory: vi.fn(), removeModel: vi.fn(), generate: vi.fn(), cancelGeneration: vi.fn() }, release: vi.fn() }));
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
    transport.remote.listModels.mockResolvedValue([{ id: '../invalid', name: 'private.gguf', size: 1, importedAt: 0 }]);
    const client = createLlamaCppWorkerClient();
    await expect(client.listModels({ signal: undefined })).rejects.toThrow();
    client.dispose();
  });
});

function generationInput(): GenerateInput {
  return { model: 'local.gguf', messages: [{ role: 'user', content: 'private prompt' }], temperature: 0,
    topP: 1, maxTokens: 5, presencePenalty: 0, frequencyPenalty: 0, stop: [], options: { profile: 'cpu-wasm32' } };
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
    transport.remote.generate.mockResolvedValueOnce({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
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

describe('directory import cancellation', () => {
  it('requests cooperative cancellation so the worker can roll back before responding', async () => {
    let rejectImport: (error: Error) => void = () => {};
    transport.remote.importDirectory.mockImplementation(() => new Promise((_resolve, reject) => {
      rejectImport = reject;
    }));
    const client = createLlamaCppWorkerClient(); const controller = new AbortController();
    const pending = client.importDirectory({ directory: { name: 'Model', files: [{ path: 'model.gguf', file: new File(['data'], 'model.gguf') }] }, signal: controller.signal, onProgress: () => {} });
    controller.abort();
    expect(transport.remote.cancelGeneration).toHaveBeenCalledWith({ generationId: 1 });
    expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
    rejectImport(new LlamaCppBrowserError({ code: 'aborted' }));
    await expect(pending).rejects.toThrow('aborted');
    expect(client.canReuse()).toBe(true); client.dispose();
  });
});

describe('host snapshots of native operations', () => {
  it('keeps the current native tensor checkpoint while the inference worker is stuck', async () => {
    vi.useFakeTimers(); const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      onDiagnostic({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', tokens: 101 } });
      onDiagnostic({ diagnostic: { event: 'native-node-start', stage: 'media-encode', nativeNode: 42, nativeOp: 26, nativeOpName: 'GGML_OP_MUL_MAT', nativeTensorType: 0, nativeTensorShape: [768, 240, 1, 1] } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: { ...generationInput(), debug: 'on' }, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    await vi.advanceTimersByTimeAsync(15000);
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'operation-waiting', lastStage: 'media-encode', lastEvent: 'native-node-start', nativeNode: 42, nativeOpName: 'GGML_OP_MUL_MAT', nativeTensorShape: [768, 240, 1, 1] }));
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'private failure', cancelable: true }));
    await expect(pending).rejects.toThrow('worker-failed');
    expect(readDiagnostics({ calls: debug.mock.calls }).at(-1)).toEqual(expect.objectContaining({ event: 'failed', nativeNode: 42, nativeTensorShape: [768, 240, 1, 1] }));
    debug.mockRestore();
  });
  it('keeps a failure checkpoint with debug off without emitting periodic wait details', async () => {
    vi.useFakeTimers(); const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      onDiagnostic({ diagnostic: { event: 'operation-start', stage: 'media-decode', batchTokens: 64 } });
      onDiagnostic({ diagnostic: { event: 'native-info', stage: 'media-encode', nativeOperation: 'copy-image', imageWidth: 328, imageHeight: 92 } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: { ...generationInput(), debug: 'off' }, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    await vi.advanceTimersByTimeAsync(60000); expect(debug).not.toHaveBeenCalled();
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'private failure', cancelable: true }));
    await expect(pending).rejects.toThrow('worker-failed');
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'failed', lastStage: 'media-encode', nativeOperation: 'copy-image', imageWidth: 328, imageHeight: 92 }));
    debug.mockRestore();
  });
  it('retains native batch details and monitors the outer helper after an inner operation completes', async () => {
    vi.useFakeTimers(); const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    let report: ({ diagnostic }: { diagnostic: Diagnostic }) => void = () => {};
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      report = onDiagnostic;
      report({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', positions: 101 } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient(); const pending = client.generate({ request: { ...generationInput(), debug: 'on' }, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    report({ diagnostic: { event: 'operation-start', stage: 'media-encode', mediaType: 'image' } });
    report({ diagnostic: { event: 'operation-complete', stage: 'media-encode', mediaType: 'image', elapsedMs: 20 } });
    report({ diagnostic: { event: 'operation-start', stage: 'media-decode', mediaType: 'image', batchIndex: 1, batchCount: 1, batchTokens: 64 } });
    await vi.advanceTimersByTimeAsync(15000);
    expect(readDiagnostics({ calls: debug.mock.calls }).at(-1)).toEqual(expect.objectContaining({ event: 'operation-waiting', lastStage: 'media-decode', batchIndex: 1, batchCount: 1, batchTokens: 64 }));
    report({ diagnostic: { event: 'operation-complete', stage: 'media-decode', mediaType: 'image', batchIndex: 1, batchCount: 1, elapsedMs: 15000 } });
    await vi.advanceTimersByTimeAsync(15000);
    expect(readDiagnostics({ calls: debug.mock.calls }).at(-1)).toEqual(expect.objectContaining({ event: 'operation-waiting', stage: 'image-evaluate', lastStage: 'media-decode', lastEvent: 'operation-complete', positions: 101, elapsedMs: 30000 }));
    report({ diagnostic: { event: 'operation-complete', stage: 'image-evaluate', nextPosition: 101 } });
    debug.mockClear(); await vi.advanceTimersByTimeAsync(60000); expect(debug).not.toHaveBeenCalled();
    client.dispose(); await expect(pending).rejects.toThrow('worker-failed'); debug.mockRestore();
  });
  it('reports the last checkpoint and known GPU reason when the worker crashes', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      onDiagnostic({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', imageCount: 1, tokens: 101, positions: 101 } });
      onDiagnostic({ diagnostic: { event: 'native-error', failureKind: 'webgpu-dispatch-limit' } });
      onDiagnostic({ diagnostic: { event: 'native-error', failureKind: 'webgpu-validation' } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: generationInput(), signal: undefined, onChunk: () => {}, onProgress: () => {} });
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'private error with path and image content', cancelable: true }));
    await expect(pending).rejects.toThrow('worker-failed');
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'failed', stage: 'worker-error', lastStage: 'image-evaluate', lastEvent: 'operation-start', tokens: 101, failureKind: 'webgpu-dispatch-limit' }));
    expect(debug.mock.calls).toHaveLength(1); expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
    debug.mockRestore();
  });
  it('reports a long native wait without cancelling it and stops reporting after disposal', async () => {
    vi.useFakeTimers(); const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      onDiagnostic({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', tokens: 101 } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient(); const pending = client.generate({ request: { ...generationInput(), debug: 'on' }, signal: undefined, onChunk: () => {}, onProgress: () => {} });
    await vi.advanceTimersByTimeAsync(14999); expect(debug).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'operation-waiting', lastStage: 'image-evaluate', elapsedMs: 15000, tokens: 101 }));
    expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
    client.dispose(); await expect(pending).rejects.toThrow('worker-failed');
    debug.mockClear(); await vi.advanceTimersByTimeAsync(60000); expect(debug).not.toHaveBeenCalled(); debug.mockRestore();
  });
  it('classifies a known worker error message without printing its raw contents', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    transport.remote.listModels.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const pending = client.listModels({ signal: undefined });
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'Dispatch workgroup count X (95760) exceeds max compute workgroups per dimension (65535). private path', cancelable: true }));
    await expect(pending).rejects.toThrow('worker-failed');
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ failureKind: 'webgpu-dispatch-limit', dispatchAxis: 'x', dispatchCount: 95760, dispatchLimit: 65535 }));
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private'); debug.mockRestore();
  });
});
