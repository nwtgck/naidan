// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activateUpdate } from './activate-update';

function worker({ state }: { state: ServiceWorkerState }) {
  const handle = Object.assign(new EventTarget(), { state, postMessage: vi.fn() });
  return { handle, native: handle as unknown as ServiceWorker };
}
afterEach(() => vi.useRealTimers());
describe('prepared-worker activation boundary', () => {
  it('accepts an already activated worker without sending another command', async () => {
    const w = worker({ state: 'activated' });
    await activateUpdate({ worker: w.native, signal: new AbortController().signal });
    expect(w.handle.postMessage).not.toHaveBeenCalled();
  });
  it.each(['parsed', 'installing', 'redundant'] as const)('rejects an unusable %s worker', async state => {
    const w = worker({ state });
    await expect(activateUpdate({ worker: w.native, signal: new AbortController().signal })).rejects.toThrow();
    expect(w.handle.postMessage).not.toHaveBeenCalled();
  });
  it('releases its timer and listener when postMessage throws', async () => {
    vi.useFakeTimers(); const w = worker({ state: 'installed' });
    const remove = vi.spyOn(w.handle, 'removeEventListener');
    w.handle.postMessage.mockImplementation(() => {
      throw new Error('terminated');
    });
    await expect(activateUpdate({ worker: w.native, signal: new AbortController().signal })).rejects.toThrow('terminated');
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('statechange', expect.any(Function));
  });
  it('does not send anything after cancellation', async () => {
    const w = worker({ state: 'installed' }); const abort = new AbortController(); abort.abort();
    await expect(activateUpdate({ worker: w.native, signal: abort.signal })).rejects.toThrow('stopped');
    expect(w.handle.postMessage).not.toHaveBeenCalled();
  });
});
