import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductionWorkerSession } from './production-worker-session';
import { PRODUCTION_WORKER_READY, startProductionWorkerRuntime } from './production-worker-startup';

const mocks = vi.hoisted(() => ({ wrap: vi.fn(), release: vi.fn() }));
vi.mock('@/utils/worker-transport', () => ({
  wrapWorkerRemote: mocks.wrap,
  releaseWorkerRemote: mocks.release,
}));

class LifecycleWorker extends EventTarget {
  terminate = vi.fn();
  postMessage = vi.fn();
}

const sessions: ReturnType<typeof createProductionWorkerSession>[] = [];
function fixture() {
  const worker = new LifecycleWorker();
  const session = createProductionWorkerSession({ worker: worker as unknown as Worker, startupTimeoutMs: 100 });
  sessions.push(session);
  return { worker, session };
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('Production Worker startup ownership', () => {
  it('announces ready only after entry evaluation has exposed its API', async () => {
    const entry = Promise.withResolvers<void>();
    const postMessage = vi.fn();
    let exposed = false;
    const startup = startProductionWorkerRuntime({
      loadEntry: async () => {
        await entry.promise; exposed = true;
      },
      postMessage: args => {
        expect(exposed).toBe(true); postMessage(args);
      },
    });
    expect(postMessage).not.toHaveBeenCalled();
    entry.resolve();
    await startup;
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ message: PRODUCTION_WORKER_READY });
  });

  it('forwards an entry import failure into pending RPCs without ever announcing ready', async () => {
    const { session, worker } = fixture();
    const operation = vi.fn();
    const result = session.run({ operation });
    const rejected = expect(result).rejects.toMatchObject({ reason: 'initialization-failed', message: expect.stringContaining('entry failed') });
    const error = new Error('entry failed');
    await expect(startProductionWorkerRuntime({
      loadEntry: async () => {
        throw error;
      },
      postMessage: ({ message }) => worker.dispatchEvent(new MessageEvent('message', { data: message })),
    })).rejects.toBe(error);
    await rejected;
    expect(operation).not.toHaveBeenCalled();
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('bounds startup itself, rejects all waiters, and ignores a late ready', async () => {
    vi.useFakeTimers();
    const { session, worker } = fixture();
    const operation = vi.fn();
    const first = expect(session.run({ operation })).rejects.toMatchObject({ reason: 'startup-timeout' });
    const second = expect(session.run({ operation })).rejects.toMatchObject({ reason: 'startup-timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await first;
    await second;
    worker.dispatchEvent(new MessageEvent('message', { data: PRODUCTION_WORKER_READY }));
    await expect(session.run({ operation })).rejects.toMatchObject({ reason: 'startup-timeout' });
    expect(operation).not.toHaveBeenCalled();
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('does not apply the startup timeout to an already running model operation', async () => {
    vi.useFakeTimers();
    const { session, worker } = fixture();
    mocks.wrap.mockReturnValue({});
    const held = Promise.withResolvers<string>();
    const operation = vi.fn(() => held.promise);
    const result = session.run({ operation });
    worker.dispatchEvent(new MessageEvent('message', { data: PRODUCTION_WORKER_READY }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.terminate).not.toHaveBeenCalled();
    held.resolve('finished');
    await expect(result).resolves.toBe('finished');
    expect(operation).toHaveBeenCalledOnce();
    session.dispose();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rejects malformed startup protocol but ignores unrelated Comlink messages', async () => {
    const { session, worker } = fixture();
    const operation = vi.fn();
    const rejected = expect(session.run({ operation })).rejects.toMatchObject({ reason: 'invalid-startup-message' });
    worker.dispatchEvent(new MessageEvent('message', { data: { id: 'rpc', value: 'ready' } }));
    expect(session.isActive()).toBe(true);
    worker.dispatchEvent(new MessageEvent('message', { data: { ...PRODUCTION_WORKER_READY, version: 2 } }));
    await rejected;
    expect(operation).not.toHaveBeenCalled();
  });

  it('preserves normal model rejection and permits a subsequent RPC', async () => {
    const { session, worker } = fixture();
    mocks.wrap.mockReturnValue({});
    worker.dispatchEvent(new MessageEvent('message', { data: PRODUCTION_WORKER_READY }));
    const incompatibility = new Error('unsupported graph');
    await expect(session.run({ operation: async () => {
      throw incompatibility;
    } })).rejects.toBe(incompatibility);
    await expect(session.run({ operation: async () => 'next candidate' })).resolves.toBe('next candidate');
    expect(session.isActive()).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('removes startup listeners and timer on terminal disposal and preserves its first failure', async () => {
    vi.useFakeTimers();
    const { session, worker } = fixture();
    const removeListener = vi.spyOn(worker, 'removeEventListener');
    const operation = vi.fn();
    const rejected = expect(session.run({ operation })).rejects.toMatchObject({ reason: 'disposed' });
    session.dispose();
    await rejected;
    expect(removeListener.mock.calls.map(([type]) => type)).toEqual(['message', 'error', 'messageerror']);
    expect(vi.getTimerCount()).toBe(0);
    worker.dispatchEvent(new Event('messageerror'));
    worker.dispatchEvent(new MessageEvent('message', { data: PRODUCTION_WORKER_READY }));
    await expect(session.run({ operation })).rejects.toMatchObject({ reason: 'disposed' });
    expect(operation).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
