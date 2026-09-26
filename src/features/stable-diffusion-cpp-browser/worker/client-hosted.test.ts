import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageClient } from './client-hosted';
import { requestFixture as request } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
const mocks = vi.hoisted(() => ({ generate: vi.fn(), release: vi.fn(), terminate: vi.fn(), constructed: vi.fn(), workers: [] as EventTarget[] }));
vi.mock('@/utils/worker-transport', async importOriginal => ({ ...await importOriginal<typeof import('@/utils/worker-transport')>(), wrapWorkerRemote: () => ({ generate: mocks.generate }), releaseWorkerRemote: () => mocks.release(), workerProxy: ({ value }: { value: unknown }) => value }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.workers.length = 0;
  vi.stubGlobal('Worker', class extends EventTarget {
    constructor() {
      super(); mocks.constructed(); mocks.workers.push(this);
    } terminate() {
      mocks.terminate();
    }
  });
});
afterEach(() => vi.unstubAllGlobals());
it('does not create a worker before explicit generation and ignores pre-aborted requests', async () => {
  const client = createImageClient(); expect(mocks.constructed).not.toHaveBeenCalled();
  const controller = new AbortController(); controller.abort();
  await expect(client.generate({ request: request(), signal: controller.signal, onProgress: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.constructed).not.toHaveBeenCalled(); client.dispose();
});
it('cancels a permanently suspended native call and terminates its worker', async () => {
  mocks.generate.mockImplementation(() => new Promise(() => undefined));
  const controller = new AbortController(); const client = createImageClient();
  const task = client.generate({ request: request(), signal: controller.signal, onProgress: vi.fn() });
  const settled = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await settled;
  expect(mocks.terminate).toHaveBeenCalled(); expect(mocks.release).toHaveBeenCalled();
});
it('disposal rejects a pending request even when the proxy never acknowledges release', async () => {
  mocks.generate.mockImplementation(() => new Promise(() => undefined));
  mocks.release.mockImplementation(() => new Promise(() => undefined));
  const client = createImageClient(); const task = client.generate({ request: request(), signal: new AbortController().signal, onProgress: vi.fn() });
  const settled = expect(task).rejects.toMatchObject({ name: 'AbortError' }); client.dispose(); await settled;
  expect(mocks.terminate).toHaveBeenCalled();
});
it('releases worker after success and rejects malformed responses', async () => {
  const client = createImageClient();
  mocks.generate.mockResolvedValue({ png: new Blob(['fixture'], { type: 'image/png' }), width: 256, height: 256, modelVersion: 'mocked result' });
  const result = await client.generate({ request: request(), signal: new AbortController().signal, onProgress: vi.fn() });
  expect(result.modelVersion).toBe('mocked result'); expect(mocks.terminate).toHaveBeenCalled();
  mocks.generate.mockResolvedValue({ png: 'not a Blob' });
  await expect(client.generate({ request: request(), signal: new AbortController().signal, onProgress: vi.fn() })).rejects.toThrow();
  client.dispose();
});
it('reports silence from the window when the Worker/native call cannot send anything', async () => {
  vi.useFakeTimers(); const onDiagnostic = vi.fn(); mocks.generate.mockImplementation(() => new Promise(() => undefined));
  const client = createImageClient(), controller = new AbortController();
  try {
    const operation = client.generate({ request: request(), signal: controller.signal, onProgress: vi.fn(), onDiagnostic });
    const stopped = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(15000);
    expect(onDiagnostic.mock.calls.filter(([{ diagnostic }]) => diagnostic.event === 'waiting')).toHaveLength(3);
    controller.abort(); await stopped;
    const count = onDiagnostic.mock.calls.length; await vi.advanceTimersByTimeAsync(30000);
    expect(onDiagnostic).toHaveBeenCalledTimes(count);
  } finally {
    client.dispose(); vi.useRealTimers();
  }
});
it('delivers validated diagnostics before the inference promise settles and retains the last real stage', async () => {
  vi.useFakeTimers(); mocks.generate.mockImplementation(() => new Promise(() => undefined));
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  const onDiagnostic = vi.fn(), client = createImageClient(), controller = new AbortController();
  try {
    const operation = client.generate({ request: { ...request(), debug: 'on' }, signal: controller.signal, onProgress: vi.fn(), onDiagnostic });
    const stopped = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    const diagnostic = { event: 'start', stage: 'model-load', elapsedMs: 123, fields: { wasmBytes: 65536 } };
    const worker = mocks.workers[0]!;
    worker.dispatchEvent(new MessageEvent('message', { data: { type: 'naidan-image-diagnostic-v1', diagnostic } }));
    expect(onDiagnostic).toHaveBeenLastCalledWith({ diagnostic });
    expect(consoleLog.mock.calls.some(([text]) => String(text).includes('model-load'))).toBe(true);
    const count = onDiagnostic.mock.calls.length;
    worker.dispatchEvent(new MessageEvent('message', { data: { type: 'naidan-image-diagnostic-v1', diagnostic: { prompt: 'injected content' } } }));
    expect(onDiagnostic).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onDiagnostic).toHaveBeenLastCalledWith({ diagnostic: expect.objectContaining({ event: 'waiting', stage: 'model-load' }) });
    controller.abort(); await stopped;
    const after = onDiagnostic.mock.calls.length;
    worker.dispatchEvent(new MessageEvent('message', { data: { type: 'naidan-image-diagnostic-v1', diagnostic } }));
    expect(onDiagnostic).toHaveBeenCalledTimes(after);
  } finally {
    client.dispose(); consoleLog.mockRestore(); vi.useRealTimers();
  }
});

it('terminates a failed Worker once and does not relabel the native failure as cleanup', async () => {
  const native = Promise.withResolvers<never>();
  mocks.generate.mockReturnValueOnce(native.promise);
  const onDiagnostic = vi.fn(), client = createImageClient();
  const operation = client.generate({ request: request(), signal: new AbortController().signal, onProgress: vi.fn(), onDiagnostic });
  const worker = mocks.workers[0]!;
  for (const diagnostic of [
    { event: 'failed', stage: 'generation', elapsedMs: 100, message: 'memory access out of bounds', fields: { nativeCall: 'generate_image' } },
    { event: 'start', stage: 'cleanup', elapsedMs: 101, fields: { nativeCleanup: 'skipped' } },
    { event: 'failed', stage: 'worker', elapsedMs: 102, message: 'memory access out of bounds', fields: { phase: 'sampling' } },
  ]) worker.dispatchEvent(new MessageEvent('message', { data: { type: 'naidan-image-diagnostic-v1', diagnostic } }));
  const original = new Error('Image generation failed');
  const failure = expect(operation).rejects.toBe(original); native.reject(original); await failure;
  expect(onDiagnostic).toHaveBeenLastCalledWith({ diagnostic: expect.objectContaining({ event: 'failed', stage: 'generation' }) });
  expect(mocks.terminate).toHaveBeenCalledOnce(); expect(mocks.generate).toHaveBeenCalledOnce();
  const count = onDiagnostic.mock.calls.length;
  worker.dispatchEvent(new MessageEvent('message', { data: { type: 'naidan-image-diagnostic-v1', diagnostic: { event: 'start', stage: 'model-load', elapsedMs: 103, fields: {} } } }));
  expect(onDiagnostic).toHaveBeenCalledTimes(count); client.dispose();
});

it('keeps the VAE GPU error when an asynchronous Worker crash bypasses the remote promise', async () => {
  mocks.generate.mockReturnValueOnce(new Promise(() => undefined));
  const client = createImageClient(), onDiagnostic = vi.fn();
  const input = request(); input.parameters.prompt = 'private prompt';
  const operation = client.generate({ request: input, signal: new AbortController().signal, onProgress: vi.fn(), onDiagnostic });
  const failed = expect(operation).rejects.toThrow(/stage=decoding.*profile=webgpu-wasm32-asyncify/);
  const worker = mocks.workers[0]!;
  for (const diagnostic of [
    { event: 'start', stage: 'decoding', elapsedMs: 100, fields: {} },
    { event: 'gpu', stage: 'decoding', elapsedMs: 101, message: 'uncaptured GPU error: Dispatch workgroup count X (65536) exceeds limit (65535).', fields: { name: 'GPUValidationError' } },
    { event: 'failed', stage: 'decoding', elapsedMs: 102, message: 'Aborted()', fields: { kind: 'native-abort' } },
    { event: 'start', stage: 'cleanup', elapsedMs: 103, fields: {} },
  ]) worker.dispatchEvent(new MessageEvent('message', { data: { type: 'naidan-image-diagnostic-v1', diagnostic } }));
  worker.dispatchEvent(new ErrorEvent('error', { message: 'Aborted private prompt https://secret.invalid/?token=x', filename: 'private/path.ts' }));
  await failed;
  const message = await operation.catch((error: Error) => error.message);
  expect(message).toContain('65536'); expect(message).toContain('65535'); expect(message).toContain('source=');
  expect(message).not.toContain('private prompt'); expect(message).not.toContain('secret.invalid'); expect(message).not.toContain('private/path');
  expect(onDiagnostic).toHaveBeenLastCalledWith({ diagnostic: expect.objectContaining({ event: 'failed', stage: 'decoding', message: expect.stringContaining('65536') }) });
  expect(mocks.terminate).toHaveBeenCalledOnce(); expect(mocks.generate).toHaveBeenCalledOnce(); client.dispose();
});
it('reports message deserialization failure distinctly and still releases a permanently waiting runtime', async () => {
  mocks.generate.mockReturnValueOnce(new Promise(() => undefined));
  const client = createImageClient();
  const operation = client.generate({ request: request(), signal: new AbortController().signal, onProgress: vi.fn() });
  const failed = expect(operation).rejects.toThrow('Worker message could not be decoded');
  mocks.workers[0]!.dispatchEvent(new MessageEvent('messageerror'));
  await failed; expect(mocks.terminate).toHaveBeenCalledOnce(); client.dispose();
});
it('bounds native error context even after repeated GPU errors', async () => {
  mocks.generate.mockReturnValueOnce(new Promise(() => undefined));
  const client = createImageClient();
  const operation = client.generate({ request: request(), signal: new AbortController().signal, onProgress: vi.fn() });
  const failed = expect(operation).rejects.toThrow('Its runtime has been released');
  const worker = mocks.workers[0]!;
  for (let i = 0; i < 100; i++) worker.dispatchEvent(new MessageEvent('message', { data: { type: 'naidan-image-diagnostic-v1', diagnostic: {
    event: 'gpu', stage: 'decoding', elapsedMs: i, message: 'uncaptured GPU error: ' + i + ' ' + 'X'.repeat(1900), fields: {},
  } } }));
  worker.dispatchEvent(new ErrorEvent('error')); await failed;
  const message = await operation.catch((error: Error) => error.message);
  expect(String(message).length).toBeLessThan(18000);
  expect(message).toContain('uncaptured GPU error: 99'); expect(message).not.toContain('uncaptured GPU error: 0 ');
  client.dispose();
});
