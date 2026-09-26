import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageWorker } from './impl';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
const mocks = vi.hoisted(() => ({ load: vi.fn(), run: vi.fn() }));
vi.mock('./core-loader', () => ({ loadCoreFactory: mocks.load }));
vi.mock('./session', () => ({ runImageGeneration: mocks.run }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('FileReaderSync', class {});
  vi.stubGlobal('navigator', { gpu: { requestAdapter: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());
it('keeps profile/source/runtime stage on artifact loading errors', async () => {
  mocks.load.mockRejectedValue(new Error('Image Wasm integrity mismatch'));
  await expect(createImageWorker({ reportDiagnostic: undefined }).generate(requestFixture(), vi.fn())).rejects.toThrow(
    `phase=runtime, profile=webgpu-wasm32-asyncify, source=${'a'.repeat(40)}\nImage Wasm integrity mismatch`,
  );
  expect(mocks.run).not.toHaveBeenCalled();
});
it('retains the original error and last native diagnostics when model initialization fails', async () => {
  mocks.load.mockResolvedValue({
    create: async () => ({ _sdc_abi_version: () => 2 }), wasmBinary: new Uint8Array(), moduleUrl: 'https://naidan.invalid/core.mjs',
    helpers: { schema: {}, attachCore: () => ({ pointerBytes: 4 }) },
  });
  mocks.run.mockImplementation(async ({ onProgress, onLog }) => {
    onProgress({ event: { phase: 'model', step: 0, steps: 0 } });
    for (let index = 0; index < 30; index++) onLog({ message: `native diagnostic ${index}` });
    throw new Error('Model initialization failed');
  });
  const worker = createImageWorker({ reportDiagnostic: undefined });
  const failure = await worker.generate(requestFixture(), vi.fn()).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected model failure');
  expect(failure.message).toContain('phase=model');
  expect(failure.message).toContain('Model initialization failed');
  expect(failure.message).toContain('native diagnostic 29');
  expect(failure.message).not.toContain('native diagnostic 0\n');
  await expect(worker.generate(requestFixture(), vi.fn())).rejects.toThrow('single-use');
});
it('keeps the first numeric Wasm frames without exporting a raw stack or retrying the runtime', async () => {
  mocks.load.mockResolvedValue({
    create: async () => ({ _sdc_abi_version: () => 2 }), wasmBinary: new Uint8Array(), moduleUrl: 'https://naidan.invalid/core.mjs',
    helpers: { schema: {}, attachCore: () => ({ pointerBytes: 4 }) },
  });
  const original = new WebAssembly.RuntimeError('memory access out of bounds');
  original.stack = `\
memory access out of bounds
 at wasm://wasm/abc:wasm-function[6740]:0xae1009
 at https://secret.invalid/?token=private:1:123`;
  mocks.run.mockImplementation(async ({ onProgress, onLog }) => {
    onProgress({ event: { phase: 'sampling', step: 0, steps: 8 } });
    onLog({ message: 'bpe_tokenizer.cpp:245 - split prompt "private words" to tokens ["pri", "vate"]' });
    throw original;
  });
  const reportDiagnostic = vi.fn();
  const worker = createImageWorker({ reportDiagnostic });
  const error = await worker.generate(requestFixture(), vi.fn()).catch((error: unknown) => error);
  if (!(error instanceof Error)) throw new Error('Expected native error');
  expect(error.message).toContain('phase=sampling, profile=webgpu-wasm32-asyncify');
  expect(error.message).toContain('Wasm frames: wasm-function[6740]:0xae1009');
  expect(error.message).toContain('[prompt/token diagnostic omitted]');
  expect(error.message).not.toContain('secret.invalid'); expect(error.message).not.toContain('"pri"');
  expect(reportDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ diagnostic: expect.objectContaining({
    event: 'failed', fields: { phase: 'sampling', errorType: 'wasm-trap', wasmFrames: 'wasm-function[6740]:0xae1009' },
  }) }));
  expect(mocks.load).toHaveBeenCalledOnce(); expect(mocks.run).toHaveBeenCalledOnce();
  await expect(worker.generate(requestFixture(), vi.fn())).rejects.toThrow('single-use');
});

it('publishes onAbort independently of a pending native operation, including with debug off', async () => {
  const request = requestFixture(); request.debug = 'off';
  const requestAdapter = navigator.gpu.requestAdapter;
  let abort: ((reason: unknown) => void) | undefined;
  mocks.load.mockResolvedValue({
    create: async (options: { onAbort: (reason: unknown) => void }) => {
      abort = options.onAbort; return { _sdc_abi_version: () => 2 };
    }, wasmBinary: new Uint8Array(), moduleUrl: 'https://naidan.invalid/core.mjs',
    helpers: { schema: {}, attachCore: () => ({ pointerBytes: 4 }) },
  });
  mocks.run.mockImplementation(async ({ onProgress }) => {
    onProgress({ event: { phase: 'decoding', step: 0, steps: 1 } });
    abort?.('Device callback aborted');
    throw new WebAssembly.RuntimeError('unreachable');
  });
  const reportDiagnostic = vi.fn();
  await expect(createImageWorker({ reportDiagnostic }).generate(request, vi.fn())).rejects.toThrow('phase=decoding');
  expect(reportDiagnostic).toHaveBeenCalledWith({ diagnostic: expect.objectContaining({ event: 'failed', stage: 'decoding', message: 'Device callback aborted', fields: { kind: 'native-abort', phase: 'decoding' } }) });
  expect(navigator.gpu.requestAdapter).toBe(requestAdapter);
});
