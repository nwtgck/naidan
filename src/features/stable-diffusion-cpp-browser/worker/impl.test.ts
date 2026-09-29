import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageWorker } from './impl';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import type { CoreFactory } from './core-types';
import type { PreviewControl } from '@/features/stable-diffusion-cpp-browser/types';
const mocks = vi.hoisted(() => ({ load: vi.fn(), generate: vi.fn(), createSession: vi.fn(), updatePreview: vi.fn(), close: vi.fn(), cancel: vi.fn(), encode: vi.fn() }));
vi.mock('./core-loader', () => ({ loadCoreFactory: mocks.load }));
vi.mock('./session', () => ({ createImageGenerationSession: mocks.createSession }));
vi.mock('./image-output', () => ({ encodeImagePixels: mocks.encode }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('FileReaderSync', class {});
  vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn() } });
  mocks.createSession.mockReturnValue({ generate: mocks.generate, updatePreview: mocks.updatePreview, close: mocks.close, cancel: mocks.cancel });
  mocks.encode.mockImplementation(async ({ image }) => ({ width: image.width, height: image.height, png: new Blob(['png'], { type: 'image/png' }) }));
});
afterEach(() => vi.unstubAllGlobals());
function loaded() {
  let callbacks: Parameters<CoreFactory>[0] | undefined;
  const create = vi.fn(async (options: Parameters<CoreFactory>[0]) => {
    callbacks = options; return { _sdc_abi_version: () => 2, HEAPU8: new Uint8Array(), _sdc_model_io_capabilities: () => 3 };
  });
  const helpers = { schema: {}, attachCore: vi.fn(() => ({ pointerBytes: 4 })) };
  mocks.load.mockResolvedValue({ create, wasmBinary: new Uint8Array(), moduleUrl: 'https://naidan.invalid/core.mjs', helpers });
  return { create, helpers, callbacks: () => callbacks! };
}
function pixels() {
  return { pixels: new Uint8ClampedArray(256 * 256 * 4), width: 256, height: 256, modelVersion: 'fixture', uniformOutput: false };
}
it('keeps profile/source/runtime stage on artifact loading errors', async () => {
  mocks.load.mockRejectedValue(new Error('Image Wasm integrity mismatch'));
  const worker = createImageWorker({ reportDiagnostic: undefined });
  await expect(worker.generate(requestFixture(), vi.fn())).rejects.toThrow(`phase=runtime, profile=webgpu-wasm32-asyncify, source=${'a'.repeat(40)}\nImage Wasm integrity mismatch`);
  expect(mocks.generate).not.toHaveBeenCalled();
  await expect(worker.generate(requestFixture(), vi.fn())).rejects.toThrow('failed'); expect(mocks.load).toHaveBeenCalledOnce();
});
it('retains the original error and last native diagnostics when model initialization fails, with no native teardown', async () => {
  loaded();
  mocks.generate.mockImplementation(async ({ onProgress, onLog }) => {
    onProgress({ event: { phase: 'model', step: 0, steps: 0 } });
    for (let index = 0; index < 30; index++) onLog({ message: `native diagnostic ${index}` });
    throw new Error('Model initialization failed');
  });
  const worker = createImageWorker({ reportDiagnostic: undefined });
  const failure = await worker.generate(requestFixture(), vi.fn()).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error); if (!(failure instanceof Error)) throw new Error('Expected failure');
  expect(failure.message).toContain('phase=model'); expect(failure.message).toContain('Model initialization failed');
  expect(failure.message).toContain('native diagnostic 29'); expect(failure.message).not.toContain('native diagnostic 0\n');
  await expect(worker.generate(requestFixture(), vi.fn())).rejects.toThrow('failed'); expect(mocks.close).not.toHaveBeenCalled();
});
it('keeps the first numeric Wasm frames without exporting raw stacks or retrying a failed runtime', async () => {
  loaded();
  const original = new WebAssembly.RuntimeError('memory access out of bounds');
  original.stack = `\
RuntimeError
 at wasm://wasm/abc:wasm-function[6740]:0xae1009
 at https://secret.invalid/?token=private:1:123`;
  mocks.generate.mockImplementation(async ({ onProgress, onLog }) => {
    onProgress({ event: { phase: 'sampling', step: 0, steps: 8 } });
    onLog({ message: 'bpe_tokenizer.cpp:245 - split prompt "private words" to tokens ["pri", "vate"]' }); throw original;
  });
  const reportDiagnostic = vi.fn(), worker = createImageWorker({ reportDiagnostic });
  const error = await worker.generate(requestFixture(), vi.fn()).catch((error: unknown) => error);
  if (!(error instanceof Error)) throw new Error('Expected error');
  expect(error.message).toContain('phase=sampling, profile=webgpu-wasm32-asyncify');
  expect(error.message).toContain('Wasm frames: wasm-function[6740]:0xae1009'); expect(error.message).toContain('[prompt/token diagnostic omitted]');
  expect(error.message).not.toContain('secret.invalid'); expect(error.message).not.toContain('"pri"');
  expect(reportDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ diagnostic: expect.objectContaining({ event: 'failed', fields: expect.objectContaining({ phase: 'sampling', errorType: 'wasm-trap', wasmFrames: 'wasm-function[6740]:0xae1009' }) }) }));
  await expect(worker.generate(requestFixture(), vi.fn())).rejects.toThrow('failed');
  expect(mocks.load).toHaveBeenCalledOnce(); expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.close).not.toHaveBeenCalled();
});
it('publishes onAbort independently of native promises, including debug off', async () => {
  const source = loaded(), request = requestFixture(); request.debug = 'off'; const requestAdapter = navigator.gpu.requestAdapter;
  mocks.generate.mockImplementation(async ({ onProgress }) => {
    onProgress({ event: { phase: 'decoding', step: 0, steps: 1 } }); source.callbacks().onAbort('Device callback aborted'); throw new WebAssembly.RuntimeError('unreachable');
  });
  const reportDiagnostic = vi.fn();
  await expect(createImageWorker({ reportDiagnostic }).generate(request, vi.fn())).rejects.toThrow('phase=decoding');
  expect(reportDiagnostic).toHaveBeenCalledWith({ diagnostic: expect.objectContaining({ event: 'failed', stage: 'decoding', message: 'Device callback aborted', fields: expect.objectContaining({ kind: 'native-abort', phase: 'decoding' }) }) });
  expect(navigator.gpu.requestAdapter).toBe(requestAdapter); expect(mocks.close).not.toHaveBeenCalled();
});
it('initializes module/context once across successful runs and routes permanent logs/abort to the CURRENT run', async () => {
  const source = loaded(), reportDiagnostic = vi.fn(), worker = createImageWorker({ reportDiagnostic });
  const first = requestFixture(); first.runId = 1; first.debug = 'on'; first.parameters.prompt = 'first secret';
  mocks.generate.mockResolvedValueOnce(pixels()); await worker.generate(first, vi.fn());
  const second = { ...first, runId: 2, parameters: { ...first.parameters, prompt: 'second secret' } };
  mocks.generate.mockImplementationOnce(async ({ onProgress }) => {
    onProgress({ event: { phase: 'decoding', step: 0, steps: 1 } });
    source.callbacks().print('observing second secret'); source.callbacks().onAbort('failure second secret');
    throw new WebAssembly.RuntimeError('unreachable');
  });
  const mark = reportDiagnostic.mock.calls.length;
  await expect(worker.generate(second, vi.fn())).rejects.toThrow('phase=decoding');
  const calls = reportDiagnostic.mock.calls.slice(mark).map(([{ diagnostic }]) => diagnostic);
  expect(calls.every(d => d.fields.runId === 2)).toBe(true);
  expect(calls.find(d => d.fields.kind === 'native-abort')?.message).toBe('failure [redacted]');
  expect(JSON.stringify(calls)).not.toContain('second secret'); expect(mocks.load).toHaveBeenCalledOnce();
  expect(source.create).toHaveBeenCalledOnce(); expect(source.helpers.attachCore).toHaveBeenCalledOnce(); expect(mocks.createSession).toHaveBeenCalledOnce();
});
it('rejects concurrent generation and changed runtime identity without creating a second native instance', async () => {
  loaded(); const gate = Promise.withResolvers<ReturnType<typeof pixels>>(), entered = Promise.withResolvers<void>();
  mocks.generate.mockImplementationOnce(() => {
    entered.resolve(); return gate.promise;
  });
  const worker = createImageWorker({ reportDiagnostic: undefined }), request = requestFixture(); request.sessionId = 'one';
  const run = worker.generate(request, vi.fn()); await entered.promise;
  await expect(worker.generate(request, vi.fn())).rejects.toThrow('busy'); gate.resolve(pixels()); await run;
  await expect(worker.generate({ ...request, sessionId: 'two' }, vi.fn())).rejects.toThrow('Replace the Worker');
  expect(mocks.createSession).toHaveBeenCalledOnce(); expect(mocks.close).not.toHaveBeenCalled();
});
it('validates live controls and applies early updates after runtime initialization; late messages never affect the next run', async () => {
  const source = loaded(), loadGate = Promise.withResolvers<Awaited<ReturnType<typeof mocks.load>>>();
  const value = await mocks.load(); mocks.load.mockReturnValueOnce(loadGate.promise);
  const request = requestFixture(); request.runId = 5;
  const worker = createImageWorker({ reportDiagnostic: undefined });
  const control: PreviewControl = { type: 'naidan-image-preview-control-v1', runId: 5, revision: 1, settings: { ...request.preview, enabled: true } };
  mocks.generate.mockImplementationOnce(async ({ onProgress }) => {
    onProgress({ event: { phase: 'model', step: 0, steps: 0 } }); return pixels();
  });
  const run = worker.generate(request, vi.fn()); worker.updatePreview({ control });
  worker.updatePreview({ control: { ...control, runId: 999, revision: 10 } });
  loadGate.resolve(value); await run;
  expect(mocks.updatePreview).toHaveBeenCalledWith({ control });
  expect(mocks.updatePreview.mock.calls.some(([{ control: c }]) => c.runId === 999)).toBe(false);
  const updates = mocks.updatePreview.mock.calls.length;
  worker.updatePreview({ control: { ...control, revision: 2 } }); expect(mocks.updatePreview).toHaveBeenCalledTimes(updates);
  expect(source.create).toHaveBeenCalledOnce();
});
it('publishes bounded preview pixels while generation remains pending and tags the actual run/step', async () => {
  loaded(); const gate = Promise.withResolvers<ReturnType<typeof pixels>>(), entered = Promise.withResolvers<void>();
  const request = requestFixture(); request.runId = 7; request.preview.enabled = true;
  const reportPreview = vi.fn();
  mocks.generate.mockImplementationOnce(({ onPreview }) => {
    onPreview({ capture: { image: pixels(), step: 2, steps: 20, revision: 0, maxEdge: 256, mode: 'projection' } });
    entered.resolve(); return gate.promise;
  });
  const task = createImageWorker({ reportDiagnostic: undefined, reportPreview }).generate(request, vi.fn()); await entered.promise;
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(reportPreview).toHaveBeenCalledWith({ frame: expect.objectContaining({ runId: 7, step: 2, revision: 0, png: expect.any(Blob) }) });
  gate.resolve(pixels()); await task;
});
it('treats an idle native abort as terminal without publishing a previous prompt', async () => {
  const source = loaded(), reportDiagnostic = vi.fn(), worker = createImageWorker({ reportDiagnostic });
  mocks.generate.mockResolvedValueOnce(pixels()); await worker.generate(requestFixture(), vi.fn());
  source.callbacks().onAbort('private prior prompt');
  expect(reportDiagnostic).toHaveBeenLastCalledWith({ diagnostic: expect.objectContaining({ event: 'failed', message: 'Image runtime failed while idle' }) });
  await expect(worker.generate(requestFixture(), vi.fn())).rejects.toThrow('failed'); expect(mocks.load).toHaveBeenCalledOnce();
});

it('delivers an early cancellation after initialization and retains the same session for the next request', async () => {
  const source = loaded(), loadGate = Promise.withResolvers<Awaited<ReturnType<typeof mocks.load>>>();
  const value = await mocks.load(); mocks.load.mockClear(); mocks.load.mockReturnValueOnce(loadGate.promise);
  const request = requestFixture(); request.runId = 11;
  const settled = Promise.withResolvers<{ cancelled: true, modelResident: boolean }>();
  mocks.generate.mockReturnValueOnce(settled.promise);
  mocks.cancel.mockImplementation(() => {
    settled.resolve({ cancelled: true, modelResident: true }); return true;
  });
  const worker = createImageWorker({ reportDiagnostic: undefined });
  const task = worker.generate(request, vi.fn());
  worker.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 99 } });
  worker.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 11 } });
  expect(mocks.cancel).not.toHaveBeenCalled();
  loadGate.resolve(value);
  await expect(task).resolves.toEqual({ cancelled: true, modelResident: true });
  expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith({ control: { type: 'naidan-image-cancel-v1', runId: 11 } });
  expect(mocks.encode).not.toHaveBeenCalled(); expect(mocks.close).not.toHaveBeenCalled();
  worker.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 11 } });
  mocks.generate.mockResolvedValueOnce(pixels());
  await worker.generate({ ...request, runId: 12 }, vi.fn());
  expect(source.create).toHaveBeenCalledOnce(); expect(mocks.createSession).toHaveBeenCalledOnce();
  expect(mocks.cancel).toHaveBeenCalledOnce();
});
it('discards a late-cancelled encoded image without discarding the context', async () => {
  const source = loaded(), encoded = Promise.withResolvers<{ png: Blob, width: number, height: number }>(), entered = Promise.withResolvers<void>();
  mocks.generate.mockResolvedValue(pixels());
  mocks.encode.mockImplementationOnce(() => {
    entered.resolve(); return encoded.promise;
  });
  const worker = createImageWorker({ reportDiagnostic: undefined }), request = requestFixture(); request.runId = 4;
  const task = worker.generate(request, vi.fn()); await entered.promise;
  worker.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 4 } });
  encoded.resolve({ png: new Blob(['png'], { type: 'image/png' }), width: 256, height: 256 });
  await expect(task).resolves.toEqual({ cancelled: true, modelResident: true });
  await worker.generate({ ...request, runId: 5 }, vi.fn());
  expect(source.create).toHaveBeenCalledOnce(); expect(mocks.close).not.toHaveBeenCalled();
});
it('does not treat a native abort after a cancel request as successful cancellation', async () => {
  const source = loaded(), gate = Promise.withResolvers<{ cancelled: true, modelResident: boolean }>(), entered = Promise.withResolvers<void>();
  mocks.generate.mockImplementationOnce(() => {
    entered.resolve(); return gate.promise;
  });
  const worker = createImageWorker({ reportDiagnostic: undefined }), request = requestFixture(); request.runId = 7;
  const task = worker.generate(request, vi.fn()); await entered.promise;
  worker.cancel({ control: { type: 'naidan-image-cancel-v1', runId: 7 } });
  source.callbacks().onAbort('broken instance');
  gate.resolve({ cancelled: true, modelResident: true });
  await expect(task).rejects.toThrow('aborted');
  await expect(worker.generate({ ...request, runId: 8 }, vi.fn())).rejects.toThrow('failed');
});

it('emits complete debug measurement scopes for each retained run without recreating the runtime', async () => {
  loaded();
  mocks.generate.mockImplementation(async ({ onPerformance, onDiagnostic, onLog }) => {
    onDiagnostic({ event: 'complete', stage: 'model-load', fields: {}, message: undefined });
    onPerformance({ signal: { kind: 'conditioning' } });
    onLog({ message: 'image.cpp:522 - get_learned_condition completed, taking 0.25s', level: 2 });
    onPerformance({ signal: { kind: 'sampling-progress', step: 0, steps: 20 } });
    onPerformance({ signal: { kind: 'sampling-progress', step: 1, steps: 20 } });
    return pixels();
  });
  const diagnostic = vi.fn(), worker = createImageWorker({ reportDiagnostic: diagnostic }), request = requestFixture(); request.debug = 'on';
  await worker.generate({ ...request, runId: 1 }, vi.fn()); await worker.generate({ ...request, runId: 2 }, vi.fn());
  const records = diagnostic.mock.calls.map(([{ diagnostic }]) => diagnostic);
  const totals = records.filter(e => e.fields.metric === 'run-wall');
  expect(totals).toHaveLength(2); expect(totals.map(t => t.fields.runId)).toEqual([1, 2]);
  expect(totals.map(t => t.fields.nativeConditionMs)).toEqual([250, 250]);
  expect(records.filter(e => e.fields.metric === 'gpu-counters' && e.fields.scope === 'run-total')).toHaveLength(2);
  expect(mocks.load).toHaveBeenCalledOnce(); expect(mocks.createSession).toHaveBeenCalledOnce();
});
it('flushes cancelled and failing measurement scopes but never enters native cleanup after a failure', async () => {
  loaded(); const request = requestFixture(); request.debug = 'on';
  const cancelledLog = vi.fn(); mocks.generate.mockResolvedValueOnce({ cancelled: true, modelResident: true });
  await createImageWorker({ reportDiagnostic: cancelledLog }).generate(request, vi.fn());
  expect(cancelledLog.mock.calls.some(([e]) => e.diagnostic.fields.metric === 'run-wall' && e.diagnostic.fields.outcome === 'cancelled')).toBe(true);
  const failedLog = vi.fn(); mocks.generate.mockRejectedValueOnce(new WebAssembly.RuntimeError('trap'));
  await expect(createImageWorker({ reportDiagnostic: failedLog }).generate(request, vi.fn())).rejects.toThrow('trap');
  expect(failedLog.mock.calls.some(([e]) => e.diagnostic.fields.metric === 'run-wall' && e.diagnostic.fields.outcome === 'failed')).toBe(true);
  expect(failedLog.mock.calls.some(([e]) => e.diagnostic.fields.metric === 'gpu-counters' && e.diagnostic.fields.scope === 'run-total')).toBe(true);
  expect(mocks.close).not.toHaveBeenCalled();
});
it('does not add detailed performance records for debug OFF', async () => {
  loaded(); mocks.generate.mockResolvedValue(pixels()); const diagnostic = vi.fn(); const request = requestFixture(); request.debug = 'off';
  await createImageWorker({ reportDiagnostic: diagnostic }).generate(request, vi.fn());
  expect(diagnostic.mock.calls.some(([e]) => e.diagnostic.fields.metric !== undefined)).toBe(false);
});
