// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createNativeSpeechObservation } from './native-observation';
import { observedNativeFixture } from './native-observation.test-support';
import { openNativeSpeechRecognitionModel } from '@/features/speech-cpp-browser/recognition/worker/native-model';
import { recognitionFile } from '@/features/speech-cpp-browser/recognition/recognition.test-support';
import type { SpeechInvestigationEvent } from '@/features/speech-cpp-browser/investigation/types';

it.each([4, 8] as const)('reads %s-byte metadata handles and log pointers without narrowing uint64 device capacities', async pointerBytes => {
  const native = observedNativeFixture({ pointerBytes }), events: SpeechInvestigationEvent[] = [];
  native.api.speech_device_memory = vi.fn(async (_index, total, free) => {
    const view = new DataView(native.heap.buffer);
    view.setBigUint64(Number(free), 8589934592n, true);
    view.setBigUint64(Number(total), 17179869184n, true);
    return 0;
  });
  const observation = createNativeSpeechObservation({ core: native.core, observer: ({ event }) => events.push(event), modelBytes: 100, now: () => 0 })!;
  await observation.open();
  expect(native.addFunction.mock.calls[0]![1]).toBe(pointerBytes === 4 ? 'viii' : 'vijj');
  native.heap.set(new TextEncoder().encode('native message\0'), 60000);
  native.addFunction.mock.calls[0]![0](1, pointerBytes === 4 ? 60000 : 60000n, pointerBytes === 4 ? 0 : 0n);
  await observation.loadedModel({ model: 30n });
  await observation.devices();
  await observation.close();
  expect(events).toContainEqual({ kind: 'native_log_batch', lines: [{ level: 'info', text: 'native message' }], dropped: 0 });
  expect(events).toContainEqual(expect.objectContaining({ kind: 'model_info' }));
  expect(events).toContainEqual({ kind: 'devices', devices: [expect.objectContaining({ totalBytes: { status: 'observed', value: '17179869184', source: 'speech_device_memory' }, freeBytes: { status: 'observed', value: '8589934592', source: 'speech_device_memory' } })] });
});

it('does no native calls, callback registration, clock or read accounting when observation is off', () => {
  const native = observedNativeFixture({ pointerBytes: 8 }), now = vi.fn(() => 0);
  expect(createNativeSpeechObservation({ core: native.core, observer: undefined, modelBytes: 100, now })).toBeUndefined();
  expect(now).not.toHaveBeenCalled();
  expect(native.addFunction).not.toHaveBeenCalled();
  expect(native.api.speech_log_set).not.toHaveBeenCalled();
  expect(native.api.speech_model_get_info).not.toHaveBeenCalled();
});

it('copies borrowed native UTF immediately and bounds logs without freeing a live Worker router slot', async () => {
  using stderr = {
    spy: vi.spyOn(console, 'error').mockImplementation(() => {}),
    [Symbol.dispose]() {
      this.spy.mockRestore();
    },
  };
  const native = observedNativeFixture({ pointerBytes: 8 }), events: SpeechInvestigationEvent[] = [];
  const observation = createNativeSpeechObservation({ core: native.core, observer: ({ event }) => events.push(event), modelBytes: 100, now: () => 0 })!;
  await observation.open();
  const callback = native.addFunction.mock.calls[0]![0];
  native.heap.set(new TextEncoder().encode('native line\0'), 60000);
  callback(2, 60000n, 0n);
  native.heap.fill(0, 60000, 60012);
  expect(events).toContainEqual({ kind: 'native_log_batch', lines: [{ level: 'warn', text: 'native line' }], dropped: 0 });
  native.heap.set(new TextEncoder().encode('x'.repeat(8192)), 60000);
  for (let index = 0; index < 300; index++) {
    callback(1, 60000n, 0n);
  }
  await observation.close();
  const logs = events.filter(event => event.kind === 'native_log_batch');
  expect(logs.flatMap(event => event.lines).reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(128 * 1024);
  expect(logs.reduce((sum, event) => sum + event.dropped, 0)).toBeGreaterThan(0);
  expect(native.api.speech_log_set).toHaveBeenCalledOnce();
  expect(native.removeFunction).not.toHaveBeenCalled();
  expect(stderr.spy).toHaveBeenCalledWith('native line');
});

it('keeps per-operation sinks separate and ignores callbacks and reads after close', async () => {
  const native = observedNativeFixture({ pointerBytes: 8 }), first: SpeechInvestigationEvent[] = [], second: SpeechInvestigationEvent[] = [], now = vi.fn(() => 0);
  const old = createNativeSpeechObservation({ core: native.core, observer: ({ event }) => first.push(event), modelBytes: 100, now })!;
  await old.open();
  const oldCallback = native.addFunction.mock.calls[0]![0];
  await old.close();
  const oldCount = first.length, clockCount = now.mock.calls.length;
  old.read({ offset: 0, length: 8 });
  oldCallback(1, 60000n, 0n);
  expect(first).toHaveLength(oldCount);
  expect(now).toHaveBeenCalledTimes(clockCount);
  const next = createNativeSpeechObservation({ core: native.core, observer: ({ event }) => second.push(event), modelBytes: 100, now })!;
  await next.open();
  native.heap.set(new TextEncoder().encode('new operation\0'), 60000);
  native.addFunction.mock.calls[0]![0](1, 60000n, 0n);
  await next.close();
  expect(first).toHaveLength(oldCount);
  expect(second).toContainEqual({ kind: 'native_log_batch', lines: [{ level: 'info', text: 'new operation' }], dropped: 0 });
  expect(native.addFunction).toHaveBeenCalledOnce();
});

it.each([16, 8192])('reserves warning and error detail after verbose %s-character logs exhaust their quota', async length => {
  using stderr = {
    spy: vi.spyOn(console, 'error').mockImplementation(() => {}),
    [Symbol.dispose]() {
      this.spy.mockRestore();
    },
  };
  const native = observedNativeFixture({ pointerBytes: 8 }), events: SpeechInvestigationEvent[] = [];
  const observation = createNativeSpeechObservation({ core: native.core, observer: ({ event }) => events.push(event), modelBytes: 100, now: () => 0 })!;
  await observation.open();
  const callback = native.addFunction.mock.calls[0]![0];
  native.heap.set(new TextEncoder().encode(`${'i'.repeat(length)}\0`), 60000);
  for (let index = 0; index < 300; index++) {
    callback(1, 60000n, 0n);
  }
  native.heap.fill(0, 60000, 70000);
  native.heap.set(new TextEncoder().encode('warning detail\0'), 60000);
  for (let index = 0; index < 100; index++) {
    callback(2, 60000n, 0n);
  }
  native.heap.fill(0, 60000, 70000);
  native.heap.set(new TextEncoder().encode('allocation failed: WebGPU buffer, 123456 bytes\0'), 60000);
  callback(3, 60000n, 0n);
  await observation.close();
  const batches = events.filter(event => event.kind === 'native_log_batch'), lines = batches.flatMap(event => event.lines);
  expect(lines).toContainEqual({ level: 'warn', text: 'warning detail' });
  expect(lines).toContainEqual({ level: 'error', text: 'allocation failed: WebGPU buffer, 123456 bytes' });
  expect(lines.length).toBeLessThanOrEqual(256);
  expect(lines.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(128 * 1024);
  expect(batches.reduce((sum, batch) => sum + batch.dropped, 0)).toBeGreaterThan(0);
  void stderr;
});

it('preserves native and ggml warnings/errors after diagnostics while ordinary logs do no observation work', async () => {
  using stderr = {
    spy: vi.spyOn(console, 'error').mockImplementation(() => {}),
    [Symbol.dispose]() {
      this.spy.mockRestore();
    },
  };
  const native = observedNativeFixture({ pointerBytes: 8 }), events: SpeechInvestigationEvent[] = [], now = vi.fn(() => 0);
  const observation = createNativeSpeechObservation({ core: native.core, observer: ({ event }) => events.push(event), modelBytes: 100, now })!;
  await observation.open();
  const callback = native.addFunction.mock.calls[0]![0];
  native.heap.set(new TextEncoder().encode('during investigation\0'), 60000);
  callback(2, 60000n, 0n);
  await observation.close();
  const eventCount = events.length, clockCount = now.mock.calls.length;
  native.heap.set(new TextEncoder().encode('normal warning\0'), 60000);
  callback(2, 60000n, 0n);
  native.heap.set(new TextEncoder().encode('normal error\0'), 60000);
  callback(3, 60000n, 0n);
  callback(0, 60000n, 0n);
  expect(stderr.spy.mock.calls.map(([message]) => message)).toEqual(['during investigation', 'normal warning', 'normal error']);
  expect(events).toHaveLength(eventCount);
  expect(now).toHaveBeenCalledTimes(clockCount);
  expect(native.api.speech_log_set).toHaveBeenCalledOnce();
  expect(native.removeFunction).not.toHaveBeenCalled();
});

it('preserves model-info JSON and uint64 values while marking unreported device memory and ASR seed honestly', async () => {
  const native = observedNativeFixture({ pointerBytes: 8 }), events: SpeechInvestigationEvent[] = [];
  const observation = createNativeSpeechObservation({ core: native.core, observer: ({ event }) => events.push(event), modelBytes: 100, now: () => 10 })!;
  await observation.loadedModel({ model: 30n });
  await observation.devices();
  await observation.result({ result: 50n, nativeStatus: 0 });
  await observation.close();
  expect(events).toContainEqual(expect.objectContaining({ kind: 'model_info', rawJson: native.strings.get(500n), weightBytes: { status: 'observed', value: '1234567890123456789', source: 'speech_model_info_weight_bytes' } }));
  expect(events).toContainEqual({ kind: 'devices', devices: [{ name: 'WebGPU0', description: 'Runtime GPU', kind: 'gpu', totalBytes: { status: 'unknown', reason: expect.any(String) }, freeBytes: { status: 'unknown', reason: expect.any(String) } }] });
  expect(events).toContainEqual({ kind: 'result', nativeStatus: 0, stop: { status: 'observed', value: 0, source: 'speech_result_stop' }, seed: { status: 'not_applicable', reason: expect.any(String) }, details: undefined });
  expect(native.api.speech_model_info_free).toHaveBeenCalledOnce();
});

it('counts actual native requests and unique ranges without treating overlapping reads as new bytes', async () => {
  const native = observedNativeFixture({ pointerBytes: 8 }), events: SpeechInvestigationEvent[] = [];
  let time = 0;
  const observation = createNativeSpeechObservation({ core: native.core, observer: ({ event }) => events.push(event), modelBytes: 65536, now: () => time })!;
  observation.read({ offset: 0, length: 32 });
  observation.read({ offset: 16, length: 2048 });
  observation.read({ offset: 2048, length: 16384 });
  time = 20;
  await observation.close();
  expect(events).toContainEqual({ kind: 'read_summary', calls: 3, totalBytes: 18464, uniqueBytes: { status: 'observed', value: 18432, source: 'native random-access read callbacks' }, maximumChunkBytes: 16384, smallReads: 2, elapsedMilliseconds: 20 });
});

it('distinguishes cached native requests from actual Blob reads without copying their buffers', async () => {
  const native = observedNativeFixture({ pointerBytes: 8 }), events: SpeechInvestigationEvent[] = [];
  let time = 0;
  const observation = createNativeSpeechObservation({ core: native.core, observer: ({ event }) => events.push(event), modelBytes: 65536, now: () => time })!;
  const bytes = new ArrayBuffer(16384);
  expect(observation.readBlob({
    blob: new Blob([bytes]),
    readBlob() {
      time += 5;
      return bytes;
    },
  })).toBe(bytes);
  observation.read({ offset: 0, length: 8 });
  observation.read({ offset: 8, length: 8 });
  await observation.close();
  expect(events).toContainEqual(expect.objectContaining({ kind: 'read_summary', calls: 2, totalBytes: 16 }));
  expect(events).toContainEqual({ kind: 'stage', stage: 'model_file_source_reads', state: 'completed', durationMilliseconds: 5, heapBytes: native.heap.byteLength, details: { calls: 1, bytesReturned: 16384, maximumChunkBytes: 16384, smallReads: 0, failures: 0, boundary: 'sum of synchronous Blob reader calls; excludes native memory copies' } });
});

it('preserves a native failure before diagnostic teardown can change the native error buffer', async () => {
  const native = observedNativeFixture({ pointerBytes: 8 }), events: SpeechInvestigationEvent[] = [];
  const file = await recognitionFile({ architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000 });
  const model = await openNativeSpeechRecognitionModel({ ...native, file, signal: new AbortController().signal, readBlob: () => new ArrayBuffer(0), onProgress() {} });
  await using cleanup = {
    async [Symbol.asyncDispose]() {
      await model.release();
    },
  };
  native.api.speech_transcribe = vi.fn(async () => -5);
  native.api.speech_request_free = vi.fn(async () => {
    native.strings.set(300n, 'changed by cleanup');
  });
  await expect(model.transcribe({ samples: new Float32Array(4), sampleRate: 16000, language: undefined, onProgress() {}, investigation: ({ event }) => events.push(event) })).rejects.toMatchObject({ details: { nativeStatus: -5, nativeInput: 'audio', message: 'native error' } });
  expect(events).toContainEqual({ kind: 'failure', stage: 'speech_transcribe', failure: { code: 'runtime_failed', message: 'native error', nativeStatus: -5, nativeInput: 'audio' } });
  expect(native.strings.get(300n)).toBe('changed by cleanup');
  void cleanup;
});
