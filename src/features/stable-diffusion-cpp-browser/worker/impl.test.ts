import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageWorker } from './impl';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
const mocks = vi.hoisted(() => ({ load: vi.fn(), run: vi.fn() }));
vi.mock('./core-loader', () => ({ loadCoreFactory: mocks.load }));
vi.mock('./session', () => ({ runImageGeneration: mocks.run }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('FileReaderSync', class {});
  vi.stubGlobal('navigator', { gpu: {} });
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
