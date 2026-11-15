import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SpeechWorker } from './protocol';
import type { SpeechState, SpeechModelInfo } from '@/features/speech-cpp-browser/types';
import { createSpeechClient } from './client-hosted';
import type { z } from 'zod';

const transport = vi.hoisted(() => ({
  remotes: [] as SpeechWorker[],
  assigned: new Map<SpeechWorker, object>(),
  listeners: new Map<object, Set<({ value }: { value: unknown }) => void>>(),
}));
vi.mock('virtual:speech-cpp-browser/config', () => ({ default: { kind: 'available', sourceCommit: 'a'.repeat(40), artifact: { profile: 'webgpu-wasm64-jspi', modulePath: 'fixture', wasmPath: 'fixture', helpersPath: 'fixture', schemaSha256: 'b'.repeat(64), wasmSha256: 'c'.repeat(64), wasmBytes: 8 } } }));
vi.mock('@/utils/worker-transport', () => ({
  wrapWorkerRemote: ({ endpoint }: { endpoint: object }) => {
    const remote = transport.remotes.shift()!;
    transport.assigned.set(remote, endpoint);
    return remote;
  },
  releaseWorkerRemote: () => undefined,
  postWorkerNotification: () => undefined,
  subscribeWorkerNotifications: ({ endpoint, schema, listener }: { endpoint: object, schema: z.ZodType, listener: ({ value }: { value: unknown }) => void }) => {
    const listeners = transport.listeners.get(endpoint) ?? new Set();
    const wrapped = ({ value }: { value: unknown }) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        listener({ value: parsed.data });
      }
    };
    listeners.add(wrapped);
    transport.listeners.set(endpoint, listeners);
    return () => listeners.delete(wrapped);
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
const info: SpeechModelInfo = { name: 'model.gguf', bytes: 100, architecture: 'haru', task: 'dialogue', sampleRate: 24000, frameSamples: 3200, requiredVersion: '0.11.0' };

function emitState({ remote, phase, model }: { remote: SpeechWorker, phase: SpeechState['phase'], model: SpeechModelInfo | undefined }): void {
  const endpoint = transport.assigned.get(remote)!;
  for (const listener of transport.listeners.get(endpoint) ?? []) {
    listener({ value: { type: 'naidan_speech_state_v1', state: { phase, model, queuedSamples: 0 } } });
  }
}

function remoteFixture({ load, push }: { load: Promise<void> | undefined, push: Promise<void> | undefined }): SpeechWorker {
  return {
    loadModel: vi.fn(async () => {
      await load;
    }),
    start: vi.fn(async () => {}),
    push: vi.fn(async () => {
      await push;
    }),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
    releaseModel: vi.fn(async () => {}),
  };
}

function clientFixture() {
  const states: SpeechState[] = [];
  const client = createSpeechClient({ observers: { onFrame() {}, onState: ({ state }) => states.push(state) } });
  return {
    client,
    states,
    async [Symbol.asyncDispose]() {
      await client.dispose();
    },
  };
}

beforeEach(() => {
  workers.length = 0;
  transport.remotes.length = 0;
  transport.assigned.clear();
  transport.listeners.clear();
  vi.stubGlobal('Worker', WorkerDouble);
  vi.stubGlobal('navigator', { gpu: {} });
  vi.stubGlobal('WebAssembly', { validate: () => true, Suspending: class {}, promising: () => {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('removes model ownership atomically when its Worker crashes', async () => {
  const remote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await fixture.client.loadModel({ file: new File([], 'a.gguf') });
  emitState({ remote, phase: 'ready', model: info });
  workers[0]!.dispatchEvent(new Event('error'));
  expect(fixture.client.getState()).toMatchObject({ phase: 'failed', model: undefined });
  expect(fixture.states.at(-1)?.model).toBeUndefined();
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
});

it('reserves ownership before awaited teardown when load is called twice in one turn', async () => {
  const remote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  const first = fixture.client.loadModel({ file: new File([], 'a.gguf') });
  const rejected = expect(first).rejects.toThrow();
  const secondFile = new File([], 'b.gguf');
  await fixture.client.loadModel({ file: secondFile });
  await rejected;
  expect(workers).toHaveLength(1);
  expect(remote.loadModel).toHaveBeenCalledWith(expect.objectContaining({ file: secondFile }));
});

it('ignores completion from a retired load after the new Worker owns its model', async () => {
  const gate = Promise.withResolvers<void>();
  const firstRemote = remoteFixture({ load: gate.promise, push: undefined });
  const secondRemote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(firstRemote, secondRemote);
  await using fixture = clientFixture();
  const first = fixture.client.loadModel({ file: new File([], 'a.gguf') });
  const rejected = expect(first).rejects.toThrow();
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  await fixture.client.loadModel({ file: new File([], 'b.gguf') });
  emitState({ remote: secondRemote, phase: 'ready', model: { ...info, name: 'b.gguf' } });
  gate.resolve();
  await rejected;
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(workers[1]!.terminate).not.toHaveBeenCalled();
  expect(fixture.client.getState().model?.name).toBe('b.gguf');
});

it('prevents delayed construction after disposal and bounds shutdown of a busy Worker', async () => {
  await using neverStarted = clientFixture();
  const loading = neverStarted.client.loadModel({ file: new File([], 'a.gguf') });
  const rejected = expect(loading).rejects.toThrow();
  await neverStarted.client.dispose();
  await rejected;
  expect(workers).toHaveLength(0);

  const remote = remoteFixture({ load: undefined, push: undefined });
  remote.stop = vi.fn(() => new Promise<void>(() => {}));
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await fixture.client.loadModel({ file: new File([], 'b.gguf') });
  emitState({ remote, phase: 'running', model: info });
  vi.useFakeTimers();
  const stop = fixture.client.stop({ mode: 'cancel' });
  const failed = expect(stop).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(3000);
  await failed;
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(fixture.client.getState()).toMatchObject({ phase: 'failed', model: undefined });
});

it('publishes drained queue ownership after the final worker notification precedes its RPC acknowledgement', async () => {
  const gate = Promise.withResolvers<void>();
  const remote = remoteFixture({ load: undefined, push: gate.promise });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await fixture.client.loadModel({ file: new File([], 'queue.gguf') });
  emitState({ remote, phase: 'ready', model: info });
  await fixture.client.start({ options: { inputSampleRate: 24000, maxSeconds: 30, language: 'ja', persona: undefined, name: undefined } });
  emitState({ remote, phase: 'running', model: info });
  expect(fixture.client.push({ samples: new Float32Array(1000), sampleRate: 24000 })).toEqual({ kind: 'accepted' });
  expect(fixture.states.at(-1)?.queuedSamples).toBe(1000);
  await vi.waitFor(() => expect(remote.push).toHaveBeenCalledOnce());
  emitState({ remote, phase: 'running', model: info });
  gate.resolve();
  await vi.waitFor(() => expect(fixture.client.getState().queuedSamples).toBe(0));
  expect(fixture.states.at(-1)?.queuedSamples).toBe(0);
});

it('does not clear a new model when an earlier explicit release settles late', async () => {
  const gate = Promise.withResolvers<void>();
  const firstRemote = remoteFixture({ load: undefined, push: undefined });
  const secondRemote = remoteFixture({ load: undefined, push: undefined });
  firstRemote.releaseModel = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
  transport.remotes.push(firstRemote, secondRemote);
  await using fixture = clientFixture();
  await fixture.client.loadModel({ file: new File([], 'a.gguf') });
  const release = fixture.client.releaseModel();
  const cancelled = expect(release).rejects.toThrow();
  await fixture.client.loadModel({ file: new File([], 'b.gguf') });
  emitState({ remote: secondRemote, phase: 'ready', model: { ...info, name: 'b.gguf' } });
  gate.resolve();
  await cancelled;
  expect(fixture.client.getState().model?.name).toBe('b.gguf');
  expect(workers[1]!.terminate).not.toHaveBeenCalled();
});

it('retires failed native ownership and preserves its details while an RPC is pending', async () => {
  const gate = Promise.withResolvers<void>();
  const remote = remoteFixture({ load: gate.promise, push: undefined });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  const loading = fixture.client.loadModel({ file: new File([], 'failed.gguf') });
  const rejected = expect(loading).rejects.toMatchObject({ details: { nativeStatus: -5, nativeInput: 'device' } });
  await vi.waitFor(() => expect(workers).toHaveLength(1));
  const failure = { code: 'runtime_failed', message: 'native device error', nativeStatus: -5, nativeInput: 'device' };
  for (const listener of transport.listeners.get(transport.assigned.get(remote)!) ?? []) {
    listener({ value: { type: 'naidan_speech_state_v1', state: { phase: 'failed', model: undefined, queuedSamples: 0, failure } } });
  }
  await rejected;
  gate.resolve();
  expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  expect(fixture.client.getState()).toMatchObject({ phase: 'failed', model: undefined, failure });
});
