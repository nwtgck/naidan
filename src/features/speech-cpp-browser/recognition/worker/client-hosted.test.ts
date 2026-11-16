import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SpeechRecognitionWorker } from './protocol';
import { createSpeechRecognitionClient } from './client-hosted';
import { recognitionInfo } from '@/features/speech-cpp-browser/recognition/recognition.test-support';
import { createSpeechRecognitionController } from '@/features/speech-cpp-browser/recognition/controller';

const selectedProfile = vi.hoisted(() => ({ value: 'webgpu-wasm64-jspi' }));
const transport = vi.hoisted(() => ({ remotes: [] as SpeechRecognitionWorker[], post: vi.fn(), transfers: vi.fn() }));
vi.mock('virtual:speech-cpp-browser/config', () => ({
  default: {
    kind: 'available',
    artifact: {
      get profile() {
        return selectedProfile.value;
      },
    },
  },
}));
vi.mock('@/utils/worker-transport', () => ({
  wrapWorkerRemote: () => transport.remotes.shift()!,
  releaseWorkerRemote: () => undefined,
  postWorkerNotification: transport.post,
  subscribeWorkerNotifications: () => () => {},
  workerTransfer: ({ value, transferables }: { value: object, transferables: Transferable[] }) => {
    transport.transfers({ value, transferables });
    return structuredClone(value, { transfer: transferables });
  },
}));
const workers: WorkerDouble[] = [];
class WorkerDouble extends EventTarget {
  terminate = vi.fn();

  constructor() {
    super();
    workers.push(this);
  }
}

function remoteFixture(): SpeechRecognitionWorker {
  return { loadModel: vi.fn<SpeechRecognitionWorker['loadModel']>(async () => ({ kind: 'loaded', model: recognitionInfo })), transcribe: vi.fn<SpeechRecognitionWorker['transcribe']>(async () => ({ kind: 'recognized', result: { text: 'こんにちは', languages: ['ja'], status: 'complete' } })), releaseModel: vi.fn(async () => {}) };
}

function clientFixture() {
  const client = createSpeechRecognitionClient({ observers: { onState() {} } });
  return {
    client,
    async [Symbol.asyncDispose]() {
      await client.dispose();
    },
  };
}

beforeEach(() => {
  selectedProfile.value = 'webgpu-wasm64-jspi';
  workers.length = 0;
  transport.remotes.length = 0;
  transport.post.mockClear();
  transport.transfers.mockClear();
  vi.stubGlobal('Worker', WorkerDouble);
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('WebAssembly', { validate: () => true, Suspending: class {}, promising() {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('accepts wasm32 without Memory64 while preserving the selected wasm64 and JSPI requirements', async () => {
  const validate = vi.fn(() => false);
  vi.stubGlobal('WebAssembly', { validate, Suspending: class {}, promising() {} });
  await using legacy = clientFixture();
  expect(legacy.client.capability).toEqual({ kind: 'unavailable', reason: 'memory64_unavailable' });
  selectedProfile.value = 'webgpu-wasm32-jspi';
  await using modern = clientFixture();
  expect(modern.client.capability).toEqual({ kind: 'available' });
  expect(validate).toHaveBeenCalledOnce();
  vi.stubGlobal('WebAssembly', { validate });
  await using noJspi = clientFixture();
  expect(noJspi.client.capability).toEqual({ kind: 'unavailable', reason: 'jspi_unavailable' });
});

it('transfers PCM ownership once and physically retires the previous heap before loading another model', async () => {
  const first = remoteFixture(), second = remoteFixture();
  second.loadModel = vi.fn<SpeechRecognitionWorker['loadModel']>(async () => {
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    return { kind: 'loaded', model: { ...recognitionInfo, name: 'second.gguf' } };
  });
  transport.remotes.push(first, second);
  await using fixture = clientFixture();
  await fixture.client.loadModel({ file: new File([], 'first.gguf') });
  const samples = new Float32Array([0, 0.25, -0.5]);
  const buffer = samples.buffer;
  const result = await fixture.client.transcribe({ samples, sampleRate: 24000, language: undefined });
  expect(result).toMatchObject({ text: 'こんにちは', status: 'complete' });
  expect(buffer.byteLength).toBe(0);
  expect(transport.transfers).toHaveBeenCalledOnce();
  const received = vi.mocked(first.transcribe).mock.calls[0]![0];
  expect(Array.from(received.samples)).toEqual([0, 0.25, -0.5]);
  expect(received.sampleRate).toBe(24000);
  expect(received.language).toBeUndefined();
  await fixture.client.loadModel({ file: new File([], 'second.gguf') });
  expect(first.releaseModel).toHaveBeenCalledOnce();
  expect(fixture.client.getState().model?.name).toBe('second.gguf');
  await fixture.client.releaseModel();
  expect(workers[1]!.terminate).toHaveBeenCalledOnce();
  expect(fixture.client.getState().model).toBeUndefined();
});

it('keeps native error option/status across the worker response and terminates failed ownership', async () => {
  const remote = remoteFixture();
  remote.transcribe = vi.fn<SpeechRecognitionWorker['transcribe']>(async () => ({ kind: 'failed', failure: { code: 'runtime_failed', message: 'native device error', nativeStatus: -5, nativeInput: 'device' } }));
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await fixture.client.loadModel({ file: new File([], 'model.gguf') });
  await expect(fixture.client.transcribe({ samples: new Float32Array(4), sampleRate: 16000, language: undefined })).rejects.toMatchObject({ details: { nativeStatus: -5, nativeInput: 'device' } });
  expect(fixture.client.getState()).toMatchObject({ phase: 'failed', model: undefined, failure: { nativeStatus: -5, nativeInput: 'device' } });
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
});

it('bounds cancellation of a wedged native call and does not reuse its high-water heap', async () => {
  vi.useFakeTimers();
  const remote = remoteFixture();
  remote.transcribe = vi.fn<SpeechRecognitionWorker['transcribe']>(() => new Promise(() => {}));
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await fixture.client.loadModel({ file: new File([], 'model.gguf') });
  const recognition = fixture.client.transcribe({ samples: new Float32Array(4), sampleRate: 16000, language: undefined });
  const rejected = expect(recognition).rejects.toThrow();
  const cancelled = fixture.client.cancel();
  expect(transport.post).toHaveBeenCalledWith(expect.objectContaining({ value: { type: 'naidan_recognition_cancel_v1' } }));
  await vi.advanceTimersByTimeAsync(3000);
  await cancelled;
  await rejected;
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(fixture.client.getState()).toMatchObject({ phase: 'unloaded', model: undefined });
});

it('reports a forced cancellation as cancelled through the real controller/client boundary', async () => {
  vi.useFakeTimers();
  const remote = remoteFixture();
  remote.transcribe = vi.fn<SpeechRecognitionWorker['transcribe']>(() => new Promise(() => {}));
  transport.remotes.push(remote);
  const controller = createSpeechRecognitionController({ createClient: createSpeechRecognitionClient, decodeFile: async () => new Float32Array(160), now: () => performance.now(), onChange() {} });
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      await controller.dispose();
    },
  };
  await controller.load({ file: new File([], 'model.gguf') });
  const running = controller.runFile({ file: new File([], 'input.wav'), language: undefined });
  await vi.advanceTimersByTimeAsync(0);
  expect(remote.transcribe).toHaveBeenCalledOnce();
  const cancelling = controller.cancel();
  await vi.advanceTimersByTimeAsync(3000);
  await cancelling;
  await running;
  expect(controller.getState()).toMatchObject({ runtime: { phase: 'unloaded', failure: undefined }, run: { status: 'cancelled', failure: undefined } });
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  void cleanup;
});

it('cancels a pending model load without accepting its late result', async () => {
  const remote = remoteFixture();
  const loaded = Promise.withResolvers<Awaited<ReturnType<SpeechRecognitionWorker['loadModel']>>>();
  remote.loadModel = vi.fn<SpeechRecognitionWorker['loadModel']>(() => loaded.promise);
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  const loading = fixture.client.loadModel({ file: new File([], 'model.gguf') });
  const rejected = expect(loading).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  await fixture.client.cancel();
  await rejected;
  loaded.resolve({ kind: 'loaded', model: recognitionInfo });
  await Promise.resolve();
  expect(fixture.client.getState()).toMatchObject({ phase: 'unloaded', model: undefined });
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
});

it('prevents superseded and disposed loads from creating a late Worker', async () => {
  const remote = remoteFixture();
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  const first = fixture.client.loadModel({ file: new File([], 'first.gguf') });
  const rejected = expect(first).rejects.toThrow();
  await fixture.client.loadModel({ file: new File([], 'second.gguf') });
  await rejected;
  expect(workers).toHaveLength(1);
  expect(remote.loadModel).toHaveBeenCalledWith(expect.objectContaining({ file: expect.objectContaining({ name: 'second.gguf' }) }));
  await fixture.client.dispose();
  await expect(fixture.client.loadModel({ file: new File([], 'late.gguf') })).rejects.toThrow();
  expect(workers).toHaveLength(1);
});
