import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionWorkerSession } from './production-worker-session';
import { PRODUCTION_WORKER_READY, startProductionWorkerRuntime } from './production-worker-startup';

import { createProductionRuntimeStartupFixture, installProductionRuntimeStartupPlatform, productionRuntimeModuleFixtureBytes } from '@/features/transformers-js/runtime/fixtures/production-runtime-startup-fixture';

const mocks = vi.hoisted(() => ({ wrap: vi.fn(), release: vi.fn() }));
vi.mock('@/utils/worker-transport', () => ({
  wrapWorkerRemote: mocks.wrap,
  releaseWorkerRemote: mocks.release,
}));

class LifecycleWorker extends EventTarget {
  terminate = vi.fn();
  readonly startup = createProductionRuntimeStartupFixture({ emitFromWorker: ({ message }) => this.dispatchEvent(new MessageEvent('message', { data: message })) });
  postMessage = vi.fn((message: unknown) => this.startup.acceptHostMessage({ message }));
  async publishReady() {
    this.startup.start(); await this.startup.ready;
  }
}

const sessions: ReturnType<typeof createProductionWorkerSession>[] = [];
function fixture() {
  const worker = new LifecycleWorker();
  const session = createProductionWorkerSession({ worker: worker as unknown as Worker, startupTimeoutMs: 100 });
  sessions.push(session);
  return { worker, session };
}

let platform: ReturnType<typeof installProductionRuntimeStartupPlatform>;
beforeEach(() => {
  platform = installProductionRuntimeStartupPlatform({ origin: 'http://localhost' });
});

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('Production Worker startup ownership', () => {
  it('keeps its host-owned URL until disposal and revokes it exactly once', async () => {
    const { worker, session } = fixture();
    mocks.wrap.mockReturnValue({});
    await worker.publishReady();
    expect(platform.createObjectURL).toHaveBeenCalledOnce();
    expect(platform.revokeObjectURL).not.toHaveBeenCalled();
    await session.run({ operation: async () => 'model unloaded, Realm still reusable' });
    expect(platform.blobs.size).toBe(1);
    session.dispose(); session.dispose();
    expect(platform.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(platform.createObjectURL.mock.results[0]?.value);
    expect(platform.blobs.size).toBe(0);
  });

  it('rejects duplicate ready and recovers the already-owned URL', async () => {
    const { worker, session } = fixture();
    mocks.wrap.mockReturnValue({});
    await worker.publishReady();
    worker.dispatchEvent(new MessageEvent('message', { data: worker.startup.readyMessage }));
    await expect(session.run({ operation: async () => 'late' })).rejects.toMatchObject({ reason: 'invalid-startup-message' });
    expect(platform.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it('preserves ACK failure when physical termination also throws and still revokes', async () => {
    const { worker, session } = fixture();
    const primary = new Error('Fixture ACK post failed');
    worker.postMessage.mockImplementation(() => {
      throw primary;
    });
    worker.terminate.mockImplementation(() => {
      throw new Error('Fixture platform terminate failed');
    });
    const result = expect(session.run({ operation: async () => 'unsafe' })).rejects.toMatchObject({ reason: 'initialization-failed', message: primary.message });
    worker.startup.start();
    await result;
    expect(platform.revokeObjectURL).toHaveBeenCalledOnce();
    expect(platform.blobs.size).toBe(0);
  });

  it('never creates a URL for verification completing after disposal', async () => {
    const digest = await crypto.subtle.digest('SHA-256', productionRuntimeModuleFixtureBytes({ variant: 'asyncify' }));
    const releaseDigest = Promise.withResolvers<ArrayBuffer>();
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    let calls = 0;
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(() => {
      if (++calls === 1) firstEntered.resolve(); else secondEntered.resolve();
      return releaseDigest.promise;
    });
    const first = fixture();
    const second = fixture();
    try {
      first.worker.startup.start();
      await firstEntered.promise;
      first.session.dispose();
      mocks.wrap.mockReturnValue({});
      second.worker.startup.start();
      await secondEntered.promise;
      // Both verifiers await this same Promise in registration order. The
      // second real acknowledgement is a completion fence, not a timed sleep.
      releaseDigest.resolve(digest);
      await second.worker.startup.ready;
      expect(first.worker.postMessage).not.toHaveBeenCalled();
      expect(platform.createObjectURL).toHaveBeenCalledOnce();
      expect(platform.blobs.size).toBe(1);
    } finally {
      digestSpy.mockRestore();
    }
  });

  it('rejects ready before a verified runtime module lease exists', async () => {
    const { worker, session } = fixture();
    mocks.wrap.mockReturnValue({});
    const operation = vi.fn(async () => 'unsafe early RPC');
    const result = session.run({ operation });
    worker.dispatchEvent(new MessageEvent('message', { data: worker.startup.readyMessage }));
    await expect(result).rejects.toMatchObject({ reason: 'invalid-startup-message' });
    expect(operation).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('announces ready only after entry evaluation has exposed its API', async () => {
    const entry = Promise.withResolvers<void>();
    const postMessage = vi.fn();
    let exposed = false;
    const startup = startProductionWorkerRuntime({
      loadEntry: async () => {
        await entry.promise; exposed = true;
        return { requestId: '11111111-1111-4111-8111-111111111111' };
      },
      postMessage: args => {
        expect(exposed).toBe(true); postMessage(args);
      },
    });
    expect(postMessage).not.toHaveBeenCalled();
    entry.resolve();
    await startup;
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ message: { ...PRODUCTION_WORKER_READY, requestId: '11111111-1111-4111-8111-111111111111' } });
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
    await worker.publishReady();
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
    worker.dispatchEvent(new MessageEvent('message', { data: { ...PRODUCTION_WORKER_READY, version: 999 } }));
    await rejected;
    expect(operation).not.toHaveBeenCalled();
  });

  it('preserves normal model rejection and permits a subsequent RPC', async () => {
    const { session, worker } = fixture();
    mocks.wrap.mockReturnValue({});
    await worker.publishReady();
    const incompatibility = new Error('unsupported graph');
    await expect(session.run({ operation: async () => {
      throw incompatibility;
    } })).rejects.toBe(incompatibility);
    await expect(session.run({ operation: async () => 'next candidate' })).resolves.toBe('next candidate');
    expect(session.isActive()).toBe(true);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it('retires the Realm on a transported resource cleanup failure and rejects every pending RPC', async () => {
    const { session, worker } = fixture();
    mocks.wrap.mockReturnValue({});
    await worker.publishReady();
    const held = Promise.withResolvers<string>();
    const failure = Promise.withResolvers<string>();
    const concurrent = session.run({ operation: async () => held.promise });
    const failing = session.run({ operation: async () => failure.promise });
    // The transport reconstructs name/message, not the Worker-side prototype.
    const transported = new Error('Fixture cleanup never settled');
    transported.name = 'RequiredDownloadedResourceCleanupError';
    const terminal = { name: 'ProductionWorkerLifecycleError', reason: 'resource-cleanup-failed' };
    const concurrentRejected = expect(concurrent).rejects.toMatchObject(terminal);
    const failingRejected = expect(failing).rejects.toMatchObject(terminal);
    const bothRejected = Promise.all([concurrentRejected, failingRejected]);
    failure.reject(transported);
    await bothRejected;
    expect(session.isActive()).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
    const next = vi.fn();
    await expect(session.run({ operation: next })).rejects.toMatchObject(terminal);
    expect(next).not.toHaveBeenCalled();
    held.resolve('late stale result');
    await Promise.resolve();
    session.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('retires the Realm when invocation synchronously reports a resource cleanup failure', async () => {
    const { session, worker } = fixture();
    mocks.wrap.mockReturnValue({});
    await worker.publishReady();
    const transported = new Error('Fixture synchronous cleanup failure');
    transported.name = 'RequiredDownloadedResourceCleanupError';
    await expect(session.run({ operation: () => {
      throw transported;
    } })).rejects.toMatchObject({ name: 'ProductionWorkerLifecycleError', reason: 'resource-cleanup-failed' });
    expect(session.isActive()).toBe(false);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('does not infer a terminal cleanup failure from message wording alone', async () => {
    const { session, worker } = fixture();
    mocks.wrap.mockReturnValue({});
    await worker.publishReady();
    const ordinary = new Error('RequiredDownloadedResourceCleanupError: fixture model rejection');
    await expect(session.run({ operation: async () => {
      throw ordinary;
    } })).rejects.toBe(ordinary);
    expect(session.isActive()).toBe(true);
    await expect(session.run({ operation: async () => 'next RPC' })).resolves.toBe('next RPC');
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
