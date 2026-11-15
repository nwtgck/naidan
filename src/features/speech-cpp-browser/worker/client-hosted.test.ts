import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SpeechWorker } from './protocol';
import type { SpeechState, SpeechModelInfo } from '@/features/speech-cpp-browser/types';
import { createSpeechClient } from './client-hosted';
import type { z } from 'zod';
import { createSpeechFileRun } from '@/features/live-conversation/logic/speech-file-run';
import type { SpeechObservers } from './types';

const transport = vi.hoisted(() => ({
  remotes: [] as SpeechWorker[],
  assigned: new Map<SpeechWorker, object>(),
  listeners: new Map<object, Set<({ value }: { value: unknown }) => void>>(),
  post: vi.fn(),
}));
vi.mock('virtual:speech-cpp-browser/config', () => ({ default: { kind: 'available', sourceCommit: 'a'.repeat(40), artifact: { profile: 'webgpu-wasm64-jspi', modulePath: 'fixture', wasmPath: 'fixture', helpersPath: 'fixture', schemaSha256: 'b'.repeat(64), wasmSha256: 'c'.repeat(64), wasmBytes: 8 } } }));
vi.mock('@/utils/worker-transport', () => ({
  wrapWorkerRemote: ({ endpoint }: { endpoint: object }) => {
    const remote = transport.remotes.shift()!;
    transport.assigned.set(remote, endpoint);
    return remote;
  },
  releaseWorkerRemote: () => undefined,
  postWorkerNotification: transport.post,
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
  const onFrame = vi.fn<SpeechObservers['onFrame']>(), onState = vi.fn<SpeechObservers['onState']>();
  const client = createSpeechClient({
    observers: {
      onFrame,
      onState: ({ state }) => {
        states.push(state);
        onState({ state });
      },
    },
  });
  return {
    client,
    states,
    onFrame,
    onState,
    async [Symbol.asyncDispose]() {
      await client.dispose();
    },
  };
}

async function startFixture({ fixture, remote, sampleRate }: { fixture: ReturnType<typeof clientFixture>, remote: SpeechWorker, sampleRate: number }): Promise<void> {
  await fixture.client.loadModel({ file: new File([], 'queue.gguf') });
  emitState({ remote, phase: 'ready', model: info });
  await fixture.client.start({ options: { inputSampleRate: sampleRate, maxSeconds: 30, language: 'ja', persona: undefined, name: undefined, seed: undefined } });
  emitState({ remote, phase: 'running', model: info });
}

beforeEach(() => {
  workers.length = 0;
  transport.remotes.length = 0;
  transport.assigned.clear();
  transport.listeners.clear();
  transport.post.mockClear();
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

it('sends investigation context as data and drops notifications from a retired Worker', async () => {
  const remote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(remote);
  const received = vi.fn<NonNullable<SpeechObservers['onInvestigation']>>();
  const client = createSpeechClient({ observers: { onFrame() {}, onState() {}, onInvestigation: received } });
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      await client.dispose();
    },
  };
  const context = { operationId: 'attempt', source: 'investigation' as const };
  await client.loadModel({ file: new File([], 'model.gguf'), investigation: context });
  expect(remote.loadModel).toHaveBeenCalledWith(expect.objectContaining({ investigation: context }));
  emitState({ remote, phase: 'ready', model: info });
  await client.start({ options: { inputSampleRate: 24000, maxSeconds: 10, language: 'ja', persona: undefined, name: undefined, seed: undefined }, investigation: context });
  const listeners = [...transport.listeners.get(transport.assigned.get(remote)!)!];
  const event = { kind: 'wasm_heap', capacityBytes: 65536 };
  for (const listener of listeners) {
    listener({ value: { type: 'naidan_speech_investigation_v1', context, event } });
  }
  expect(received).toHaveBeenCalledOnce();
  expect(received).toHaveBeenCalledWith({ context, event });
  await client.releaseModel();
  for (const listener of listeners) {
    listener({ value: { type: 'naidan_speech_investigation_v1', context, event } });
  }
  expect(received).toHaveBeenCalledOnce();
  void cleanup;
});

it('subscribes to diagnostic notifications only while an explicit operation is active', async () => {
  const remote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(remote);
  const client = createSpeechClient({ observers: { onFrame() {}, onState() {}, onInvestigation() {} } });
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      await client.dispose();
    },
  };
  await client.loadModel({ file: new File([], 'model.gguf') });
  const listeners = transport.listeners.get(transport.assigned.get(remote)!)!;
  expect(listeners.size).toBe(2);
  emitState({ remote, phase: 'ready', model: info });
  const options = { inputSampleRate: 24000, maxSeconds: 10, language: 'ja', persona: undefined, name: undefined, seed: undefined };
  await client.start({ options });
  expect(listeners.size).toBe(2);
  await client.stop({ mode: 'finish' });
  emitState({ remote, phase: 'ready', model: info });
  await client.start({ options, investigation: { operationId: 'diagnostic', source: 'investigation' } });
  expect(listeners.size).toBe(3);
  await client.stop({ mode: 'finish' });
  expect(listeners.size).toBe(2);
  void cleanup;
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
  await fixture.client.start({ options: { inputSampleRate: 24000, maxSeconds: 30, language: 'ja', persona: undefined, name: undefined, seed: undefined } });
  emitState({ remote, phase: 'running', model: info });
  expect(fixture.client.push({ samples: new Float32Array(3200), sampleRate: 24000 })).toEqual({ kind: 'accepted' });
  expect(fixture.states.at(-1)?.queuedSamples).toBe(3200);
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

it('combines microphone-sized packets into complete model frames and retains the next partial frame', async () => {
  const remote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await startFixture({ fixture, remote, sampleRate: 24000 });
  for (const size of [1012, 1024, 1024]) {
    fixture.client.push({ samples: new Float32Array(size).fill(0.25), sampleRate: 24000 });
  }
  await Promise.resolve();
  expect(remote.push).not.toHaveBeenCalled();
  expect(fixture.client.getState().queuedSamples).toBe(3060);
  fixture.client.push({ samples: new Float32Array(1024).fill(0.25), sampleRate: 24000 });
  await vi.waitFor(() => expect(fixture.client.getState().queuedSamples).toBe(884));
  expect(remote.push).toHaveBeenCalledOnce();
  expect(remote.push).toHaveBeenLastCalledWith({ samples: new Float32Array(3200).fill(0.25), sampleRate: 24000 });
  for (const size of [1024, 1024, 268]) {
    fixture.client.push({ samples: new Float32Array(size).fill(0.5), sampleRate: 24000 });
  }
  await vi.waitFor(() => expect(fixture.client.getState().queuedSamples).toBe(0));
  expect(remote.push).toHaveBeenCalledTimes(2);
  expect(vi.mocked(remote.push).mock.calls[1]?.[0].samples.slice(0, 884)).toEqual(new Float32Array(884).fill(0.25));
  expect(fixture.states.at(-1)?.queuedSamples).toBe(0);
});

it.each([137, 1024, 3199, 6400])('preserves every PCM byte across %s-sample input chunks and flushes the final partial frame', async size => {
  const remote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await startFixture({ fixture, remote, sampleRate: 24000 });
  const pcm = Float32Array.from({ length: 3200 * 5 + 77 }, (_, index) => Math.sin(index / 100) * 0.5);
  pcm[0] = -0;
  pcm[1] = 1e-42;
  for (let offset = 0; offset < pcm.length; offset += size) {
    const part = pcm.subarray(offset, offset + size);
    const buffer = new Float32Array(part.length + 4);
    buffer.set(part, 2);
    const samples = buffer.subarray(2, 2 + part.length);
    expect(fixture.client.push({ samples, sampleRate: 24000 })).toEqual({ kind: 'accepted' });
    samples.fill(0);
  }
  await fixture.client.stop({ mode: 'finish' });
  const actual = new Float32Array(pcm.length);
  let offset = 0;
  for (const [{ samples }] of vi.mocked(remote.push).mock.calls) {
    actual.set(samples, offset);
    offset += samples.length;
  }
  expect(vi.mocked(remote.push).mock.calls.map(([{ samples }]) => samples.length)).toEqual([3200, 3200, 3200, 3200, 3200, 77]);
  expect(new Uint8Array(actual.buffer)).toEqual(new Uint8Array(pcm.buffer));
  expect(fixture.client.getState().queuedSamples).toBe(0);
});

it.each([
  { sampleRate: 16000, lengths: [2134, 2133, 2133] },
  { sampleRate: 44100, lengths: [5880, 5880, 5880] },
  { sampleRate: 48000, lengths: [6400, 6400, 6400] },
])('uses the model frame duration for $sampleRate Hz input without fractional drift', async ({ sampleRate, lengths }) => {
  const remote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await startFixture({ fixture, remote, sampleRate });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  for (let offset = 0; offset < total; offset += 317) {
    fixture.client.push({ samples: new Float32Array(Math.min(317, total - offset)), sampleRate });
  }
  await fixture.client.stop({ mode: 'finish' });
  expect(vi.mocked(remote.push).mock.calls.map(([{ samples }]) => samples.length)).toEqual(lengths);
  expect(vi.mocked(remote.push).mock.calls.every(([args]) => args.sampleRate === sampleRate)).toBe(true);
});

it('waits for a partial finish to drain before stopping the native dialogue', async () => {
  const gate = Promise.withResolvers<void>();
  const remote = remoteFixture({ load: undefined, push: gate.promise });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await startFixture({ fixture, remote, sampleRate: 24000 });
  fixture.client.push({ samples: new Float32Array(999).fill(0.25), sampleRate: 24000 });
  expect(remote.push).not.toHaveBeenCalled();
  const finishing = fixture.client.stop({ mode: 'finish' });
  await vi.waitFor(() => expect(remote.push).toHaveBeenCalledOnce());
  expect(remote.push).toHaveBeenCalledWith({ samples: new Float32Array(999).fill(0.25), sampleRate: 24000 });
  expect(fixture.client.getState().queuedSamples).toBe(999);
  expect(remote.stop).not.toHaveBeenCalled();
  gate.resolve();
  await finishing;
  expect(remote.stop).toHaveBeenCalledWith({ mode: 'finish' });
  expect(fixture.states.at(-1)?.queuedSamples).toBe(0);
});

it('discards an unsent partial frame immediately on cancel while retaining the in-flight frame until acknowledgement', async () => {
  const gate = Promise.withResolvers<void>();
  const remote = remoteFixture({ load: undefined, push: gate.promise });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await startFixture({ fixture, remote, sampleRate: 24000 });
  fixture.client.push({ samples: new Float32Array(3200), sampleRate: 24000 });
  await vi.waitFor(() => expect(remote.push).toHaveBeenCalledOnce());
  fixture.client.push({ samples: new Float32Array(777), sampleRate: 24000 });
  const cancelled = fixture.client.stop({ mode: 'cancel' });
  expect(fixture.client.getState().queuedSamples).toBe(3200);
  expect(transport.post).toHaveBeenCalledWith(expect.objectContaining({ endpoint: workers[0], value: { mode: 'cancel' } }));
  gate.resolve();
  await cancelled;
  expect(remote.push).toHaveBeenCalledOnce();
  expect(fixture.states.at(-1)?.queuedSamples).toBe(0);
});

it('keeps the two-second bound inclusive of in-flight and incomplete frames', async () => {
  const gate = Promise.withResolvers<void>();
  const remote = remoteFixture({ load: undefined, push: gate.promise });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await startFixture({ fixture, remote, sampleRate: 24000 });
  fixture.client.push({ samples: new Float32Array(3200), sampleRate: 24000 });
  await vi.waitFor(() => expect(remote.push).toHaveBeenCalledOnce());
  expect(fixture.client.push({ samples: new Float32Array(44799), sampleRate: 24000 })).toEqual({ kind: 'accepted' });
  expect(fixture.client.push({ samples: new Float32Array(2), sampleRate: 24000 })).toEqual({ kind: 'backpressure' });
  expect(fixture.client.push({ samples: new Float32Array(1), sampleRate: 24000 })).toEqual({ kind: 'accepted' });
  expect(fixture.client.push({ samples: new Float32Array(1), sampleRate: 24000 })).toEqual({ kind: 'backpressure' });
  expect(fixture.client.getState().queuedSamples).toBe(48000);
  const cancelled = fixture.client.stop({ mode: 'cancel' });
  expect(fixture.client.getState().queuedSamples).toBe(3200);
  gate.resolve();
  await cancelled;
});

it('does not let a retired worker acknowledgement consume the replacement worker partial frame', async () => {
  const gate = Promise.withResolvers<void>();
  const first = remoteFixture({ load: undefined, push: gate.promise });
  const second = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(first, second);
  await using fixture = clientFixture();
  await startFixture({ fixture, remote: first, sampleRate: 24000 });
  fixture.client.push({ samples: new Float32Array(3200).fill(0.25), sampleRate: 24000 });
  await vi.waitFor(() => expect(first.push).toHaveBeenCalledOnce());
  fixture.client.push({ samples: new Float32Array(1111).fill(0.75), sampleRate: 24000 });
  await startFixture({ fixture, remote: second, sampleRate: 24000 });
  fixture.client.push({ samples: new Float32Array(1000).fill(-0.5), sampleRate: 24000 });
  gate.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(fixture.client.getState().queuedSamples).toBe(1000);
  fixture.client.push({ samples: new Float32Array(2200).fill(-0.5), sampleRate: 24000 });
  await vi.waitFor(() => expect(fixture.client.getState().queuedSamples).toBe(0));
  expect(second.push).toHaveBeenCalledOnce();
  expect(second.push).toHaveBeenCalledWith({ samples: new Float32Array(3200).fill(-0.5), sampleRate: 24000 });
});

it('disposes an incomplete batch without sending it to a released model', async () => {
  const remote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await startFixture({ fixture, remote, sampleRate: 24000 });
  fixture.client.push({ samples: new Float32Array(1000), sampleRate: 24000 });
  await fixture.client.dispose();
  expect(remote.push).not.toHaveBeenCalled();
  expect(workers[0]?.terminate).toHaveBeenCalledOnce();
  expect(fixture.client.getState()).toMatchObject({ phase: 'disposed', model: undefined, queuedSamples: 0 });
});

it('starts a fresh fractional batch boundary when reusing the same model after a partial finish', async () => {
  const remote = remoteFixture({ load: undefined, push: undefined });
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  await startFixture({ fixture, remote, sampleRate: 16000 });
  fixture.client.push({ samples: new Float32Array(2257).fill(0.25), sampleRate: 16000 });
  await fixture.client.stop({ mode: 'finish' });
  expect(vi.mocked(remote.push).mock.calls.map(([{ samples }]) => samples.length)).toEqual([2134, 123]);
  emitState({ remote, phase: 'completed', model: info });
  await fixture.client.start({ options: { inputSampleRate: 16000, maxSeconds: 30, language: 'ja', persona: undefined, name: undefined, seed: undefined } });
  emitState({ remote, phase: 'running', model: info });
  fixture.client.push({ samples: new Float32Array(2133).fill(-0.5), sampleRate: 16000 });
  await Promise.resolve();
  expect(remote.push).toHaveBeenCalledTimes(2);
  fixture.client.push({ samples: new Float32Array(1).fill(-0.5), sampleRate: 16000 });
  await vi.waitFor(() => expect(fixture.client.getState().queuedSamples).toBe(0));
  expect(remote.push).toHaveBeenLastCalledWith({ samples: new Float32Array(2134).fill(-0.5), sampleRate: 16000 });
  expect(remote.loadModel).toHaveBeenCalledOnce();
});

it('drains each full file-run frame without waiting for a later packet or finish call', async () => {
  using urls = {
    create: vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:hosted-file'),
    revoke: vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}),
    [Symbol.dispose]() {
      this.create.mockRestore();
      this.revoke.mockRestore();
    },
  };
  const remote = remoteFixture({ load: undefined, push: undefined });
  remote.start = vi.fn(async () => emitState({ remote, phase: 'running', model: info }));
  remote.stop = vi.fn(async () => emitState({ remote, phase: 'completed', model: info }));
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  const runner = createSpeechFileRun({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, client: fixture.client, file: new File(['audio'], 'greeting.wav'), options: { inputSampleRate: 24000, maxSeconds: 30, language: 'ja', persona: undefined, name: undefined, seed: 0 }, tailSeconds: 0, inputPacing: 'fast', decodeFile: async () => new Float32Array(6401).fill(0.25), onChange() {} });
  fixture.onState.mockImplementation(() => runner.onState());
  fixture.onFrame.mockImplementation(({ frame }) => runner.onFrame({ frame }));
  await using recording = {
    async [Symbol.asyncDispose]() {
      runner.clear();
    },
  };
  await fixture.client.loadModel({ file: new File([], 'model.gguf') });
  emitState({ remote, phase: 'ready', model: info });
  await runner.run();
  expect(runner.getState()).toMatchObject({ status: 'complete', sourceSamples: 6401, submittedSamples: 9600 });
  expect(remote.push).toHaveBeenCalledTimes(3);
  expect(fixture.states.at(-1)?.queuedSamples).toBe(0);
  expect(urls.create).toHaveBeenCalledOnce();
  void recording;
});

it('applies the hosted shutdown deadline at real-time EOF while a native input call is still pending', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  using visibility = {
    spy: vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'),
    [Symbol.dispose]() {
      this.spy.mockRestore();
    },
  };
  using urls = {
    create: vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:realtime-timeout'),
    revoke: vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}),
    [Symbol.dispose]() {
      this.create.mockRestore();
      this.revoke.mockRestore();
    },
  };
  const gate = Promise.withResolvers<void>();
  const remote = remoteFixture({ load: undefined, push: gate.promise });
  remote.start = vi.fn(async () => emitState({ remote, phase: 'running', model: info }));
  transport.remotes.push(remote);
  await using fixture = clientFixture();
  using unblock = {
    [Symbol.dispose]() {
      gate.resolve();
    },
  };
  const runner = createSpeechFileRun({ maximumRetainedAudioBytes: 64 * 1024 * 1024, inputLevel: { kind: 'gain' as const, gain: 1 }, client: fixture.client, file: new File(['audio'], 'greeting.wav'), options: { inputSampleRate: 24000, maxSeconds: 30, language: 'ja', persona: undefined, name: undefined, seed: 0 }, tailSeconds: 0, inputPacing: 'real_time', decodeFile: async () => new Float32Array(3200), onChange() {} });
  fixture.onState.mockImplementation(() => runner.onState());
  await using recording = {
    async [Symbol.asyncDispose]() {
      runner.clear();
    },
  };
  await fixture.client.loadModel({ file: new File([], 'model.gguf') });
  emitState({ remote, phase: 'ready', model: info });
  const running = runner.run();
  await vi.advanceTimersByTimeAsync(134);
  expect(runner.getState()).toMatchObject({ stage: 'draining_input', submittedSamples: 3200 });
  expect(remote.push).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(3000);
  expect(workers[0]?.terminate).toHaveBeenCalledOnce();
  await running;
  expect(runner.getState()).toMatchObject({ status: 'failed', failure: { message: 'Speech worker shutdown timed out' }, replayTiming: { drainDurationMilliseconds: 3000 } });
  expect(visibility.spy).toHaveBeenCalled();
  expect(urls.create).toHaveBeenCalledOnce();
  void unblock;
  void recording;
});
