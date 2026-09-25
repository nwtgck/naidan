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
