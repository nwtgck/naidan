import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { inspectImageInventory, INSPECTION_STALL_MS } from './client';
import type { InspectionReport } from './types';
const mocks = vi.hoisted(() => ({ inspect: vi.fn(), release: vi.fn(), terminate: vi.fn(), workers: [] as EventTarget[] }));
vi.mock('@/utils/worker-transport', async original => ({ ...await original<typeof import('@/utils/worker-transport')>(),
  wrapWorkerRemote: () => ({ inspect: mocks.inspect }), releaseWorkerRemote: () => mocks.release(), workerProxy: ({ value }: { value: unknown }) => value,
}));
beforeEach(() => {
  vi.resetAllMocks(); mocks.workers.length = 0;
  vi.stubGlobal('Worker', class extends EventTarget {
    terminate = mocks.terminate; constructor() {
      super(); mocks.workers.push(this);
    }
  });
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
});
it('does not create an inspector for an already cancelled request', async () => {
  const stop = new AbortController(); stop.abort();
  await expect(inspectImageInventory({ signal: stop.signal, onProgress: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.workers).toHaveLength(0);
});
it('terminates stalled inspection immediately on cancel without awaiting native/file I/O', async () => {
  mocks.inspect.mockReturnValueOnce(new Promise(() => undefined));
  const stop = new AbortController();
  const task = inspectImageInventory({ signal: stop.signal, onProgress: vi.fn() });
  stop.abort(); await expect(task).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.terminate).toHaveBeenCalledOnce(); expect(mocks.release).toHaveBeenCalledOnce();
});
it('rejects an inactive Worker with a finite timeout and releases it', async () => {
  vi.useFakeTimers(); mocks.inspect.mockReturnValueOnce(new Promise(() => undefined));
  const task = inspectImageInventory({ signal: new AbortController().signal, onProgress: vi.fn() });
  const failed = expect(task).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(INSPECTION_STALL_MS); await failed;
  expect(mocks.terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('allows a long progressing scan and forwards current file progress, not an unlimited dead wait', async () => {
  vi.useFakeTimers(); const gate = Promise.withResolvers<{ candidates: [], issues: [] }>();
  let report: InspectionReport | undefined;
  mocks.inspect.mockImplementationOnce((_files, progress) => {
    report = progress; return gate.promise;
  });
  const progress = vi.fn();
  const task = inspectImageInventory({ signal: new AbortController().signal, onProgress: progress });
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(INSPECTION_STALL_MS - 1000);
    report!({ progress: { phase: 'headers', path: 'user/model.gguf', completed: i, total: 4 } });
  }
  gate.resolve({ candidates: [], issues: [] }); expect(await task).toEqual({ candidates: [], issues: [] });
  expect(progress).toHaveBeenCalledTimes(4); expect(mocks.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['error', 'messageerror'])('settles and retires the Worker after %s', async type => {
  mocks.inspect.mockReturnValueOnce(new Promise(() => undefined));
  const task = inspectImageInventory({ signal: new AbortController().signal, onProgress: vi.fn() });
  mocks.workers[0]!.dispatchEvent(new Event(type)); await expect(task).rejects.toThrow('inspection Worker failed');
  expect(mocks.terminate).toHaveBeenCalledOnce();
});
