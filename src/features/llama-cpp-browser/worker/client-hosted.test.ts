import { createAudioPreviewRequests } from '@/features/audio-generation/preview-requests';
import type { AudioPreviewEvent } from '@/features/audio-generation/types';
import { audioResult } from '@/features/audio-generation/test-utils/wav';
import { defaultAudioParameters, type AudioGenerationInput } from '@/features/audio-generation/types';
import type { Progress } from '@/features/llama-cpp-browser/types';
import { readDiagnostics } from '@/features/llama-cpp-browser/test-utils/diagnostics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlamaCppBrowserError, type GenerateInput } from '@/features/llama-cpp-browser/types';
import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { createLlamaCppWorkerClient } from './client-hosted';
const transport = vi.hoisted(() => ({ remote: { requestAudioPreview: vi.fn(async () => {}), finishAudioGeneration: vi.fn(), generateAudio: vi.fn(), probeProfiles: vi.fn(), listModels: vi.fn(), importModel: vi.fn(), importDirectory: vi.fn(), removeModel: vi.fn(), generate: vi.fn(), cancelGeneration: vi.fn() }, release: vi.fn() }));
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
  transport.remote.cancelGeneration.mockResolvedValue(undefined); transport.remote.finishAudioGeneration.mockReset(); transport.remote.finishAudioGeneration.mockResolvedValue(undefined);
  transport.remote.generate.mockReset(); transport.remote.generateAudio.mockReset(); transport.remote.generateAudio.mockResolvedValue(audioResult());
  transport.remote.importModel.mockReset(); transport.remote.importDirectory.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.useRealTimers();
});
describe('hosted Worker lifetime', () => {
  it('validates capability reports and notifies session observers once when the Worker dies', async () => {
    const report = { recommended: 'cpu-wasm32', profiles: [{ profile: 'cpu-wasm32', status: 'available' }] };
    transport.remote.probeProfiles.mockResolvedValueOnce(report);
    const client = createLlamaCppWorkerClient(); const disposed = vi.fn();
    client.subscribeDisposed({ listener: disposed });
    await expect(client.probeProfiles({ signal: undefined })).resolves.toEqual(report);
    transport.remote.probeProfiles.mockResolvedValueOnce({ recommended: 'cpu-wasm32', profiles: [] });
    await expect(client.probeProfiles({ signal: undefined })).rejects.toThrow();
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { cancelable: true }));
    expect(disposed).toHaveBeenCalledOnce(); client.dispose(); expect(disposed).toHaveBeenCalledOnce();
    const late = vi.fn(); client.subscribeDisposed({ listener: late }); expect(late).toHaveBeenCalledOnce();
  });
  it('rejects unresolved automatic selection before a generation RPC', async () => {
    const client = createLlamaCppWorkerClient();
    await expect(client.generate({ request: { ...generationInput(), options: { profile: 'auto' } }, onEvent: () => {}, onProgress: () => {}, signal: undefined })).rejects.toThrow();
    expect(transport.remote.generate).not.toHaveBeenCalled(); client.dispose();
  });
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
  it('transmits the confirmed deletion plan and validates the deletion result', async () => {
    const client = createLlamaCppWorkerClient();
    const plan = { id: 'hf.co/owner/repo', files: [{ path: 'nested/model.gguf', size: 128, lastModified: 1 }] };
    transport.remote.removeModel.mockResolvedValueOnce('changed');
    expect(await client.removeModel({ plan, signal: undefined })).toBe('changed');
    expect(transport.remote.removeModel).toHaveBeenCalledWith({ plan });
    transport.remote.removeModel.mockResolvedValueOnce({ private: 'invalid reply' });
    await expect(client.removeModel({ plan, signal: undefined })).rejects.toThrow();
    client.dispose();
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
    const pending = client.generate({ request: generationInput(), onEvent: chunk, onProgress: progress, signal: controller.signal });
    const rejectCheck = expect(pending).rejects.toThrow('aborted');
    const call = transport.remote.generate.mock.calls[0]!;
    const onEvent = call[1] as ({ event }: { event: { type: 'text'; text: string } }) => Promise<void>;
    const onProgress = call[2] as ({ phase, completed, total }: { phase: string, completed: number, total: number }) => void;
    controller.abort();
    expect(transport.remote.cancelGeneration).toHaveBeenCalledWith({ generationId: 1 });
    expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
    await onEvent({ event: { type: 'text', text: 'private trailing content' } }); onProgress({ phase: 'loading', completed: 1, total: 1 });
    finish(); await rejectCheck;
    expect(client.canReuse()).toBe(true); expect(chunk).toHaveBeenCalledWith({ event: { type: 'text', text: 'private trailing content' } }); expect(progress).not.toHaveBeenCalled();
    transport.remote.generate.mockResolvedValueOnce({ content: '', reasoningContent: '', toolCalls: [], finishReason: 'stop' });
    await client.generate({ request: generationInput(), onEvent: chunk, onProgress: progress, signal: undefined });
    expect(transport.remote.generate.mock.calls[1]?.[0].generationId).toBe(2);
    onProgress({ phase: 'loading', completed: 1, total: 1 }); expect(progress).not.toHaveBeenCalled();
    expect(TestWorker.instances).toHaveLength(1); client.dispose();
  });
  it('terminates a Worker only when cooperative cancellation does not settle within the grace period', async () => {
    vi.useFakeTimers();
    transport.remote.generate.mockImplementationOnce(() => new Promise<void>(() => {}));
    const controller = new AbortController(); const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: generationInput(), onEvent: () => {}, onProgress: () => {}, signal: controller.signal });
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
    const pending = client.generate({ request: generationInput(), onEvent: () => {}, onProgress: () => {}, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('aborted');
    controller.abort(); await rejected; expect(client.canReuse()).toBe(false);
  });
  it('preserves the Worker after a cooperatively aborted native request', async () => {
    transport.remote.generate.mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'aborted' }));
    const client = createLlamaCppWorkerClient();
    await expect(client.generate({ request: generationInput(), onEvent: () => {}, onProgress: () => {}, signal: undefined })).rejects.toThrow('aborted');
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
    vi.useFakeTimers(); const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      onDiagnostic({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', tokens: 101 } });
      onDiagnostic({ diagnostic: { event: 'native-node-start', stage: 'media-encode', nativeNode: 42, nativeOp: 26, nativeOpName: 'GGML_OP_MUL_MAT', nativeTensorType: 0, nativeTensorShape: [768, 240, 1, 1] } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: { ...generationInput(), debug: 'on' }, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    await vi.advanceTimersByTimeAsync(15000);
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'operation-waiting', lastStage: 'media-encode', lastEvent: 'native-node-start', nativeNode: 42, nativeOpName: 'GGML_OP_MUL_MAT', nativeTensorShape: [768, 240, 1, 1] }));
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'private failure', cancelable: true }));
    await expect(pending).rejects.toThrow('worker-failed');
    expect(readDiagnostics({ calls: debug.mock.calls }).at(-1)).toEqual(expect.objectContaining({ event: 'failed', nativeNode: 42, nativeTensorShape: [768, 240, 1, 1] }));
    debug.mockRestore();
  });
  it('keeps a failure checkpoint with debug off without emitting periodic wait details', async () => {
    vi.useFakeTimers(); const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      onDiagnostic({ diagnostic: { event: 'operation-start', stage: 'media-decode', batchTokens: 64 } });
      onDiagnostic({ diagnostic: { event: 'native-info', stage: 'media-encode', nativeOperation: 'copy-image', imageWidth: 328, imageHeight: 92 } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: { ...generationInput(), debug: 'off' }, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    await vi.advanceTimersByTimeAsync(60000); expect(debug).not.toHaveBeenCalled();
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'private failure', cancelable: true }));
    await expect(pending).rejects.toThrow('worker-failed');
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'failed', lastStage: 'media-encode', nativeOperation: 'copy-image', imageWidth: 328, imageHeight: 92 }));
    debug.mockRestore();
  });
  it('retains native batch details and monitors the outer helper after an inner operation completes', async () => {
    vi.useFakeTimers(); const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    let report: ({ diagnostic }: { diagnostic: Diagnostic }) => void = () => {};
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      report = onDiagnostic;
      report({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', positions: 101 } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient(); const pending = client.generate({ request: { ...generationInput(), debug: 'on' }, signal: undefined, onEvent: () => {}, onProgress: () => {} });
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
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      onDiagnostic({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', imageCount: 1, tokens: 101, positions: 101 } });
      onDiagnostic({ diagnostic: { event: 'native-error', failureKind: 'webgpu-dispatch-limit' } });
      onDiagnostic({ diagnostic: { event: 'native-error', failureKind: 'webgpu-validation' } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient();
    const pending = client.generate({ request: generationInput(), signal: undefined, onEvent: () => {}, onProgress: () => {} });
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'private error with path and image content', cancelable: true }));
    await expect(pending).rejects.toThrow('worker-failed');
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'failed', stage: 'worker-error', lastStage: 'image-evaluate', lastEvent: 'operation-start', tokens: 101, failureKind: 'webgpu-dispatch-limit' }));
    expect(debug.mock.calls).toHaveLength(1); expect(JSON.stringify(debug.mock.calls)).not.toContain('private');
    debug.mockRestore();
  });
  it('reports a long native wait without cancelling it and stops reporting after disposal', async () => {
    vi.useFakeTimers(); const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    transport.remote.generate.mockImplementation((_request, _onChunk, _onProgress, onDiagnostic) => {
      onDiagnostic({ diagnostic: { event: 'operation-start', stage: 'image-evaluate', tokens: 101 } });
      return new Promise(() => {});
    });
    const client = createLlamaCppWorkerClient(); const pending = client.generate({ request: { ...generationInput(), debug: 'on' }, signal: undefined, onEvent: () => {}, onProgress: () => {} });
    await vi.advanceTimersByTimeAsync(14999); expect(debug).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ event: 'operation-waiting', lastStage: 'image-evaluate', elapsedMs: 15000, tokens: 101 }));
    expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
    client.dispose(); await expect(pending).rejects.toThrow('worker-failed');
    debug.mockClear(); await vi.advanceTimersByTimeAsync(60000); expect(debug).not.toHaveBeenCalled(); debug.mockRestore();
  });
  it('classifies a known worker error message without printing its raw contents', async () => {
    const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
    transport.remote.listModels.mockImplementation(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const pending = client.listModels({ signal: undefined });
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'Dispatch workgroup count X (95760) exceeds max compute workgroups per dimension (65535). private path', cancelable: true }));
    await expect(pending).rejects.toThrow('worker-failed');
    expect(readDiagnostics({ calls: debug.mock.calls })).toContainEqual(expect.objectContaining({ failureKind: 'webgpu-dispatch-limit', dispatchAxis: 'x', dispatchCount: 95760, dispatchLimit: 65535 }));
    expect(JSON.stringify(debug.mock.calls)).not.toContain('private'); debug.mockRestore();
  });
});


describe('single-file import cancellation', () => {
  it('keeps the worker and import lane alive until slow rollback completes, then accepts a retry', async () => {
    vi.useFakeTimers();
    const rollback = Promise.withResolvers<never>();
    transport.remote.importModel.mockReturnValueOnce(rollback.promise);
    const file = new File(['fixture'], 'same.gguf');
    const client = createLlamaCppWorkerClient(); const controller = new AbortController(); const progress = vi.fn();
    const pending = client.importModel({ file, onProgress: progress, signal: controller.signal });
    let settled = false;
    const rejected = expect(pending.finally(() => {
      settled = true;
    })).rejects.toThrow('aborted');
    const call = transport.remote.importModel.mock.calls[0]!;
    const report = call[1] as ({ phase, completed, total }: { phase: 'importing', completed: number, total: number }) => void;
    report({ phase: 'importing', completed: 1, total: 2 }); expect(progress).toHaveBeenCalledOnce();
    controller.abort();
    expect(transport.remote.cancelGeneration).toHaveBeenCalledWith({ generationId: call[0].generationId });
    report({ phase: 'importing', completed: 2, total: 2 }); expect(progress).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15000);
    expect(settled).toBe(false); expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
    await expect(client.importModel({ file, onProgress: () => {}, signal: undefined })).rejects.toThrow('busy');
    expect(transport.remote.importModel).toHaveBeenCalledOnce();
    rollback.reject(new LlamaCppBrowserError({ code: 'aborted' })); await rejected;
    expect(client.canReuse()).toBe(true); expect(transport.release).not.toHaveBeenCalled();
    const model = { id: 'user/same-GGUF', name: 'same-GGUF', size: 7, importedAt: 1 };
    transport.remote.importModel.mockResolvedValueOnce(model);
    await expect(client.importModel({ file, onProgress: () => {}, signal: undefined })).resolves.toEqual(model);
    expect(transport.remote.importModel.mock.calls[1]?.[0].generationId).toBeGreaterThan(call[0].generationId);
    report({ phase: 'importing', completed: 2, total: 2 }); expect(progress).toHaveBeenCalledOnce();
    expect(TestWorker.instances).toHaveLength(1); client.dispose();
  });
  it('does not send a cancelled request or accept progress callbacks after successful completion', async () => {
    const client = createLlamaCppWorkerClient(); const controller = new AbortController(); controller.abort();
    const file = new File(['fixture'], 'same.gguf'); const progress = vi.fn();
    await expect(client.importModel({ file, signal: controller.signal, onProgress: progress })).rejects.toThrow('aborted');
    expect(transport.remote.importModel).not.toHaveBeenCalled();
    transport.remote.importModel.mockResolvedValueOnce({ id: 'user/same-GGUF', name: 'same-GGUF', size: 7, importedAt: 1 });
    await client.importModel({ file, signal: undefined, onProgress: progress });
    transport.remote.importModel.mock.calls[0]?.[1]({ phase: 'importing', completed: 7, total: 7 });
    expect(progress).not.toHaveBeenCalled(); expect(client.canReuse()).toBe(true); client.dispose();
  });
  it('still rejects cancellation if the worker actually crashes during rollback', async () => {
    transport.remote.importModel.mockImplementationOnce(() => new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const controller = new AbortController();
    const pending = client.importModel({ file: new File(['fixture'], 'same.gguf'), signal: controller.signal, onProgress: () => {} });
    const rejected = expect(pending).rejects.toThrow('aborted');
    controller.abort();
    TestWorker.instances[0]?.dispatchEvent(new ErrorEvent('error', { message: 'private path', cancelable: true }));
    await rejected; expect(TestWorker.instances[0]?.terminate).toHaveBeenCalledOnce(); expect(client.canReuse()).toBe(false);
  });
});

function audioInput(): AudioGenerationInput {
  return { ...defaultAudioParameters(), model: 'user/voice', text: 'Hello', options: { profile: 'cpu-wasm32' }, debug: 'off' };
}
describe('hosted audio transport', () => {
  it('validates and returns WAV output through the dedicated method', async () => {
    const client = createLlamaCppWorkerClient();
    expect(await client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: undefined })).toEqual(audioResult());
    expect(transport.remote.generate).not.toHaveBeenCalled(); expect(transport.remote.generateAudio.mock.calls[0]?.[0]).toMatchObject({ generationId: 1, model: 'user/voice' }); client.dispose();
  });
  it('rejects unresolved automatic profiles before the audio RPC', async () => {
    const client = createLlamaCppWorkerClient();
    await expect(client.generateAudio({ request: { ...audioInput(), options: { profile: 'auto' } }, onProgress: () => {}, cancellationSignal: undefined })).rejects.toThrow();
    expect(transport.remote.generateAudio).not.toHaveBeenCalled(); client.dispose();
  });
  it('rejects malformed results', async () => {
    transport.remote.generateAudio.mockResolvedValueOnce({ ...audioResult(), wav: new Uint8Array(1) }); const client = createLlamaCppWorkerClient();
    await expect(client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: undefined })).rejects.toThrow(); client.dispose();
  });
  it('waits for cooperative cleanup and suppresses cancelled or stale audio progress', async () => {
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); transport.remote.generateAudio.mockReturnValueOnce(gate.promise);
    const client = createLlamaCppWorkerClient(); const controller = new AbortController(); const progress = vi.fn();
    const pending = client.generateAudio({ request: audioInput(), onProgress: progress, cancellationSignal: controller.signal });
    const rejected = expect(pending).rejects.toThrow('aborted');
    const onProgress = transport.remote.generateAudio.mock.calls[0]?.[1] as (progress: Progress) => void;
    controller.abort(); expect(transport.remote.cancelGeneration).toHaveBeenCalledWith({ generationId: 1 });
    onProgress({ phase: 'generating', completed: 1, total: 2 }); expect(progress).not.toHaveBeenCalled();
    gate.resolve(audioResult()); await rejected; expect(client.canReuse()).toBe(true);
    await client.generateAudio({ request: audioInput(), onProgress: progress, cancellationSignal: undefined });
    onProgress({ phase: 'generating', completed: 2, total: 2 }); expect(progress).not.toHaveBeenCalled(); client.dispose();
  });
  it('terminates hung native audio after the existing cancellation grace period', async () => {
    vi.useFakeTimers(); transport.remote.generateAudio.mockReturnValueOnce(new Promise(() => {}));
    const client = createLlamaCppWorkerClient(); const controller = new AbortController();
    const pending = client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: controller.signal }); const rejected = expect(pending).rejects.toThrow('aborted');
    controller.abort(); await vi.advanceTimersByTimeAsync(4999); expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(TestWorker.instances[0]?.terminate).toHaveBeenCalledOnce();
  });
});


describe('hosted audio finish transport', () => {
  it.each([false, true])('posts a finish request after starting the audio RPC (pre-requested: %s)', async preRequested => {
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); transport.remote.generateAudio.mockReturnValueOnce(gate.promise);
    const client = createLlamaCppWorkerClient(); const finish = new AbortController(); const abort = new AbortController();
    if (preRequested) finish.abort();
    const pending = client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: abort.signal, completionSignal: finish.signal });
    if (!preRequested) finish.abort();
    expect(transport.remote.finishAudioGeneration).toHaveBeenCalledExactlyOnceWith({ generationId: 1 });
    expect(transport.remote.generateAudio.mock.invocationCallOrder[0]!).toBeLessThan(transport.remote.finishAudioGeneration.mock.invocationCallOrder[0]!);
    expect(transport.remote.cancelGeneration).not.toHaveBeenCalled(); expect(abort.signal.aborted).toBe(false);
    gate.resolve({ ...audioResult(), finishReason: 'user-stop' });
    expect(await pending).toMatchObject({ finishReason: 'user-stop' }); expect(client.canReuse()).toBe(true); client.dispose();
  });
  it('does not arm the five-second cancellation deadline while waveform conversion is pending', async () => {
    vi.useFakeTimers(); const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); transport.remote.generateAudio.mockReturnValueOnce(gate.promise);
    const client = createLlamaCppWorkerClient(); const finish = new AbortController();
    const pending = client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: undefined, completionSignal: finish.signal });
    finish.abort(); await vi.advanceTimersByTimeAsync(60000);
    expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled(); expect(transport.remote.cancelGeneration).not.toHaveBeenCalled();
    gate.resolve(audioResult()); await pending; client.dispose();
  });
  it('detaches completed request signals and ignores their delayed finish failures', async () => {
    const finishReply = Promise.withResolvers<void>(); transport.remote.finishAudioGeneration.mockReturnValueOnce(finishReply.promise);
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); transport.remote.generateAudio.mockReturnValueOnce(gate.promise);
    const client = createLlamaCppWorkerClient(); const finish = new AbortController();
    const pending = client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: undefined, completionSignal: finish.signal });
    finish.abort(); gate.resolve(audioResult()); await pending;
    const unused = new AbortController(); await client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: undefined, completionSignal: unused.signal });
    unused.abort(); expect(transport.remote.finishAudioGeneration).toHaveBeenCalledOnce();
    finishReply.reject(new Error('late old RPC failure')); await Promise.resolve();
    expect(client.canReuse()).toBe(true); expect(TestWorker.instances[0]?.terminate).not.toHaveBeenCalled(); client.dispose();
  });
  it('can still cancel and discard after asking for a partial result', async () => {
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); transport.remote.generateAudio.mockReturnValueOnce(gate.promise);
    const client = createLlamaCppWorkerClient(); const finish = new AbortController(); const abort = new AbortController();
    const pending = client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: abort.signal, completionSignal: finish.signal });
    const rejected = expect(pending).rejects.toThrow('aborted'); finish.abort(); abort.abort();
    expect(transport.remote.cancelGeneration).toHaveBeenCalledExactlyOnceWith({ generationId: 1 });
    gate.resolve({ ...audioResult(), finishReason: 'user-stop' }); await rejected; client.dispose();
  });
});


describe('generation-scoped preview delivery', () => {
  it('forwards repeated and already-queued requests without ending generation or arming cancellation', async () => {
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); transport.remote.generateAudio.mockReturnValueOnce(gate.promise);
    const client = createLlamaCppWorkerClient(); const captures = createAudioPreviewRequests(); captures.request();
    const onPreview = vi.fn(async () => {});
    const pending = client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: undefined, preview: { requests: captures.requests, onPreview } });
    await vi.waitFor(() => expect(transport.remote.requestAudioPreview).toHaveBeenCalled());
    expect(transport.remote.requestAudioPreview).toHaveBeenLastCalledWith({ generationId: 1, requestVersion: 1 });
    const deliver = transport.remote.generateAudio.mock.calls.at(-1)![3] as (event: AudioPreviewEvent) => Promise<void>;
    const preview = { ...audioResult(), frames: 72, finishReason: 'preview' as const };
    await deliver({ result: preview, requestVersion: 1 }); await deliver({ result: preview, requestVersion: 1 });
    expect(onPreview).toHaveBeenCalledOnce(); captures.request();
    expect(transport.remote.requestAudioPreview).toHaveBeenLastCalledWith({ generationId: 1, requestVersion: 2 });
    expect(transport.remote.finishAudioGeneration).not.toHaveBeenCalled(); expect(transport.remote.cancelGeneration).not.toHaveBeenCalled();
    gate.resolve(audioResult()); await pending;
    const calls = transport.remote.requestAudioPreview.mock.calls.length; captures.request();
    await deliver({ result: preview, requestVersion: 2 });
    expect(onPreview).toHaveBeenCalledOnce(); expect(transport.remote.requestAudioPreview).toHaveBeenCalledTimes(calls);
    client.dispose();
  });
  it('ignores delayed previews after cancellation and rejects malformed or unrequested outputs', async () => {
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); transport.remote.generateAudio.mockReturnValueOnce(gate.promise);
    const client = createLlamaCppWorkerClient(); const captures = createAudioPreviewRequests(); const abort = new AbortController(); const onPreview = vi.fn();
    const pending = client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: abort.signal, preview: { requests: captures.requests, onPreview } });
    captures.request();
    const deliver = transport.remote.generateAudio.mock.calls.at(-1)![3] as (event: unknown) => Promise<void>;
    await expect(deliver({ result: audioResult(), requestVersion: 1 })).rejects.toThrow();
    await expect(deliver({ result: { ...audioResult(), finishReason: 'preview' }, requestVersion: 2 })).rejects.toThrow('worker-failed');
    abort.abort(); await deliver({ result: { ...audioResult(), finishReason: 'preview' }, requestVersion: 1 });
    expect(onPreview).not.toHaveBeenCalled(); gate.resolve(audioResult()); await expect(pending).rejects.toThrow('aborted'); client.dispose();
  });
  it('does not dispose a subsequent owner when an old preview control fails late', async () => {
    const control = Promise.withResolvers<void>(); transport.remote.requestAudioPreview.mockReturnValueOnce(control.promise);
    const gate = Promise.withResolvers<ReturnType<typeof audioResult>>(); transport.remote.generateAudio.mockReturnValueOnce(gate.promise);
    const client = createLlamaCppWorkerClient(); const captures = createAudioPreviewRequests(); const onPreview = vi.fn();
    const pending = client.generateAudio({ request: audioInput(), onProgress: () => {}, cancellationSignal: undefined, preview: { requests: captures.requests, onPreview } });
    captures.request(); gate.resolve(audioResult()); await pending;
    control.reject(new Error('late failure')); await Promise.resolve(); await Promise.resolve();
    expect(client.canReuse()).toBe(true); client.dispose();
  });
});
