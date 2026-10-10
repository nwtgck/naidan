// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ConnectionMaintenance, ConnectionOpenPermits } from './connection-maintenance';
import type { ConnectionLease, ConnectionReplacement, MaintenanceFailure } from './connection-maintenance';

async function flush(): Promise<void> {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}
function fixture({ permits = new ConnectionOpenPermits({ capacity: 4, maximumWaiting: 32 }) }: { permits?: ConnectionOpenPermits } = {}) {
  let now = 0;
  const timers: { milliseconds: number; callback(): void; cancelled: boolean }[] = [];
  const openings: { signal: AbortSignal; result: ReturnType<typeof Promise.withResolvers<ConnectionLease<number>>> }[] = [];
  const factory = vi.fn(({ signal }: { signal: AbortSignal }) => {
    const result = Promise.withResolvers<ConnectionLease<number>>(); openings.push({ signal, result }); return result.promise;
  });
  const classify = vi.fn(({ error }: { error: unknown; source: 'factory' | 'connection' }): MaintenanceFailure => error === 'fatal' ? 'blocked' : error === 'cleanup' ? 'retirement-failed' : 'retry');
  const retryDelay = vi.fn(() => 10);
  const owner = new ConnectionMaintenance({
    permits,
    factory,
    classify,
    retryDelay,
    clock: {
      now: () => now,
      schedule({ milliseconds, callback }) {
        const timer = { milliseconds, callback, cancelled: false }; timers.push(timer); return () => {
          timer.cancelled = true;
        };
      },
    },
    changed() {},
  });
  return {
    owner,
    factory,
    classify,
    retryDelay,
    openings,
    timers,
    advance({ milliseconds }: { milliseconds: number }) {
      now += milliseconds;
    },
  };
}
function connection({ value, held = false }: { value: number; held?: boolean }) {
  const ended = Promise.withResolvers<{ error: unknown }>(), stopped = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>();
  if (!held) closed.resolve();
  const retire = vi.fn(() => {
    stopped.resolve(); return closed.promise;
  });
  return { lease: { value, ended: ended.promise, retire } satisfies ConnectionLease<number>, ended, stopped, closed, retire };
}

it('repeated Connect shares one attempt outcome and never queues additional factories', async () => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }), second = state.owner.connect({ mode: 'explicit' });
  expect(second).toBe(first); await flush(); expect(state.factory).toHaveBeenCalledOnce();
  const live = connection({ value: 1 }); state.openings[0]!.result.resolve(live.lease);
  await expect(first).resolves.toBe(1); await expect(state.owner.connect({ mode: 'explicit' })).resolves.toBe(1);
  expect(state.factory).toHaveBeenCalledOnce(); await state.owner.disconnect(); expect(live.retire).toHaveBeenCalledOnce();
});

it('manual desire survives a retryable failure and retries only after owned retirement', async () => {
  const state = fixture(), opening = state.owner.connect({ mode: 'explicit' }); await flush();
  const live = connection({ value: 1, held: true }); state.openings[0]!.result.resolve(live.lease); await opening;
  live.ended.resolve({ error: new Error('Relay lost') }); await live.stopped.promise;
  expect(state.owner.desiredConnection).toBe('connected'); expect(state.owner.phase).toBe('retiring'); expect(state.timers).toHaveLength(0);
  live.closed.resolve(); await flush(); expect(state.owner.phase).toBe('backoff');
  state.advance({ milliseconds: 10 }); state.timers[0]!.callback(); await flush(); expect(state.factory).toHaveBeenCalledTimes(2);
  const replacement = connection({ value: 2 }); state.openings[1]!.result.resolve(replacement.lease); await flush();
  expect(state.owner.value).toBe(2); await state.owner.disconnect();
});

it('failed next attempt rejects Connect without clearing runtime desire', async () => {
  const state = fixture(), opening = state.owner.connect({ mode: 'explicit' }); await flush(); const error = new Error('Transient'); state.openings[0]!.result.reject(error);
  await expect(opening).rejects.toBe(error); await flush(); expect(state.owner.desiredConnection).toBe('connected'); expect(state.owner.phase).toBe('backoff');
  await state.owner.disconnect(); expect(state.timers[0]!.cancelled).toBe(true);
});

it('stop rejects pending publication immediately but joins a late factory product and its held cleanup', async () => {
  const state = fixture(), opening = state.owner.connect({ mode: 'explicit' }); await flush(); let retired = false;
  const stopping = state.owner.disconnect().then(() => {
    retired = true;
  }); await expect(opening).rejects.toThrow('cancelled');
  expect(state.openings[0]!.signal.aborted).toBe(true); expect(retired).toBe(false);
  const late = connection({ value: 1, held: true }); state.openings[0]!.result.resolve(late.lease); await late.stopped.promise;
  expect(state.owner.value).toBeUndefined(); expect(retired).toBe(false); late.closed.resolve(); await stopping;
  expect(state.owner.phase).toBe('idle'); expect(state.timers).toHaveLength(0);
});

it('Connect while old cancellation is retiring coalesces and cannot overlap the old slot', async () => {
  const state = fixture(), old = state.owner.connect({ mode: 'explicit' }); await flush(); const stopped = state.owner.disconnect(); void old.catch(() => {});
  const next = state.owner.connect({ mode: 'explicit' }); expect(state.owner.connect({ mode: 'explicit' })).toBe(next); expect(state.factory).toHaveBeenCalledOnce();
  const late = connection({ value: 1, held: true }); state.openings[0]!.result.resolve(late.lease); await late.stopped.promise;
  expect(state.factory).toHaveBeenCalledOnce(); late.closed.resolve(); await stopped; await flush(); expect(state.factory).toHaveBeenCalledTimes(2);
  const fresh = connection({ value: 2 }); state.openings[1]!.result.resolve(fresh.lease); await expect(next).resolves.toBe(2); await state.owner.disconnect();
});

it('ordinary terminal blocks retain desire, ignore passive wake and revalidate only on manual Connect', async () => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }); await flush(); state.openings[0]!.result.reject('fatal');
  await expect(first).rejects.toBe('fatal'); await flush(); expect(state.owner.blocked).toEqual({ kind: 'terminal', error: 'fatal' });
  expect(state.owner.desiredConnection).toBe('connected'); state.owner.wake(); state.owner.wake(); await flush(); expect(state.factory).toHaveBeenCalledOnce();
  const retry = state.owner.connect({ mode: 'explicit' }); await flush(); expect(state.factory).toHaveBeenCalledTimes(2);
  const live = connection({ value: 2 }); state.openings[1]!.result.resolve(live.lease); await retry; await state.owner.disconnect();
});

it('authority invalidation initiates retirement while preserving desired and blocking passive restarts', async () => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }); await flush(); const live = connection({ value: 1, held: true });
  state.openings[0]!.result.resolve(live.lease); await first; const blocked = state.owner.block({ error: 'Grant changed' });
  await live.stopped.promise; expect(state.owner.desiredConnection).toBe('connected'); expect(state.owner.value).toBeUndefined();
  state.owner.wake(); live.closed.resolve(); await blocked; await flush(); expect(state.factory).toHaveBeenCalledOnce(); expect(state.owner.phase).toBe('blocked');
  await state.owner.disconnect();
});

it.each([null, 0, false, undefined, new Error('Retirement failed')])('retirement failure preserves opaque cause and cannot be manually overridden: %s', async error => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }); await flush(); const live = connection({ value: 1, held: true });
  state.openings[0]!.result.resolve(live.lease); await first; const stopped = state.owner.disconnect(); live.closed.reject(error);
  await expect(stopped).rejects.toBe(error); expect(state.owner.blocked).toEqual({ kind: 'retirement', error });
  await expect(state.owner.connect({ mode: 'explicit' })).rejects.toBe(error); state.owner.wake(); await flush(); expect(state.factory).toHaveBeenCalledOnce();
});

it('factory retirement failure remains fatal even when the pending publication was already cancelled', async () => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }); await flush(); void first.catch(() => {});
  const stopped = state.owner.disconnect(); state.openings[0]!.result.reject('cleanup'); await expect(stopped).rejects.toBe('cleanup');
  await expect(state.owner.connect({ mode: 'explicit' })).rejects.toBe('cleanup'); expect(state.owner.blocked?.kind).toBe('retirement');
});

it('old timer and old ended callbacks cannot consume or replace a newer attempt', async () => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }); await flush(); state.openings[0]!.result.reject(new Error('Transient'));
  await expect(first).rejects.toThrow('Transient'); await flush(); const stale = state.timers[0]!;
  await state.owner.disconnect(); const second = state.owner.connect({ mode: 'explicit' }); await flush(); const live = connection({ value: 2 });
  state.openings[1]!.result.resolve(live.lease); await second; stale.callback(); await flush(); expect(state.owner.value).toBe(2); expect(state.factory).toHaveBeenCalledTimes(2);
  await state.owner.disconnect(); live.ended.resolve({ error: 'fatal' }); await flush(); expect(state.owner.blocked).toBeUndefined();
});

it('early retry callbacks preserve their original due time', async () => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }); await flush(); state.openings[0]!.result.reject('transient'); await expect(first).rejects.toBe('transient'); await flush();
  state.advance({ milliseconds: 4 }); state.timers[0]!.callback(); expect(state.timers[1]!.milliseconds).toBe(6); expect(state.factory).toHaveBeenCalledOnce();
  state.timers[0]!.callback(); expect(state.timers).toHaveLength(2); await state.owner.disconnect();
});

it('a shared opening permit remains held through a canceled late product retirement', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 2 }), a = fixture({ permits }), b = fixture({ permits });
  const first = a.owner.connect({ mode: 'background' }); await flush(); void first.catch(() => {}); const stopped = a.owner.disconnect(); const second = b.owner.connect({ mode: 'background' }); await flush();
  expect(b.factory).not.toHaveBeenCalled(); const late = connection({ value: 1, held: true }); a.openings[0]!.result.resolve(late.lease); await late.stopped.promise;
  expect(b.factory).not.toHaveBeenCalled(); late.closed.resolve(); await stopped; await flush(); expect(b.factory).toHaveBeenCalledOnce();
  const live = connection({ value: 2 }); b.openings[0]!.result.resolve(live.lease); await second; await b.owner.disconnect();
});

it('the hard cap includes healthy connections and canceled requests consume no later permit', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 4, maximumWaiting: 32 }), states = Array.from({ length: 6 }, () => fixture({ permits }));
  const requests = states.map(state => state.owner.connect({ mode: 'background' })); for (const request of requests) void request.catch(() => {}); await flush();
  expect(states.map(state => state.factory.mock.calls.length)).toEqual([1, 1, 1, 1, 0, 0]);
  await states[4]!.owner.disconnect();
  const live = connection({ value: 0 }); states[0]!.openings[0]!.result.resolve(live.lease); await requests[0]; await flush();
  expect(states[4]!.factory).not.toHaveBeenCalled(); expect(states[5]!.factory).not.toHaveBeenCalled();
  await states[0]!.owner.disconnect(); await flush(); expect(states[5]!.factory).toHaveBeenCalledOnce();
  const cleanup = states.map(state => state.owner.disconnect());
  for (const [index, state] of states.entries()) if (state.openings[0] && index !== 0) state.openings[0].result.resolve(connection({ value: index }).lease);
  await Promise.all(cleanup);
});

it('reentrant disconnect from opening observation cancels before invoking the factory', async () => {
  const factory = vi.fn(async () => connection({ value: 1 }).lease); let stopped: Promise<void> | undefined;
  const owner = new ConnectionMaintenance({
    permits: new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 1 }),
    factory,
    classify: () => 'retry',
    retryDelay: () => 10,
    clock: { now: () => 0, schedule: () => () => {} },
    changed() {
      if (owner.phase === 'opening' && !stopped) stopped = owner.disconnect();
    },
  });
  const opening = owner.connect({ mode: 'explicit' }); await expect(opening).rejects.toThrow('cancelled'); await stopped;
  expect(factory).not.toHaveBeenCalled(); expect(owner.desiredConnection).toBe('disconnected');
});

it('a throwing retire initiates shutdown once and leaves replacement permanently blocked', async () => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }); await flush(); const error = new Error('Disposer failed'), retire = vi.fn(() => {
    throw error;
  });
  state.openings[0]!.result.resolve({ value: 1, ended: new Promise(() => {}), retire }); await first;
  await expect(state.owner.disconnect()).rejects.toBe(error); await expect(state.owner.connect({ mode: 'explicit' })).rejects.toBe(error);
  expect(state.owner.desiredConnection).toBe('connected'); expect(retire).toHaveBeenCalledOnce();
});

it('failed late retirement retains the shared opening permit instead of admitting another factory', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 1 }), a = fixture({ permits }), b = fixture({ permits });
  const opening = a.owner.connect({ mode: 'background' }); await flush(); void opening.catch(() => {}); const stopped = a.owner.disconnect();
  const late = connection({ value: 1, held: true }); a.openings[0]!.result.resolve(late.lease); await late.stopped.promise;
  late.closed.reject('Held resource'); await expect(stopped).rejects.toBe('Held resource');
  const queued = b.owner.connect({ mode: 'background' }); await flush(); expect(b.factory).not.toHaveBeenCalled();
  const closing = b.owner.disconnect(); await expect(queued).rejects.toThrow('cancelled'); await closing;
});

it.each([0, -1, NaN, Infinity, 1.5, 2147483648])('invalid retry policy %s blocks without a new attempt', async milliseconds => {
  const failure = new Error('Transient'), factory = vi.fn(async () => {
      throw failure;
    }), schedule = vi.fn(() => () => {});
  const owner = new ConnectionMaintenance({
    permits: new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 1 }),
    factory,
    classify: () => 'retry',
    retryDelay: () => milliseconds,
    clock: { now: () => 0, schedule },
    changed() {},
  });
  await expect(owner.connect({ mode: 'explicit' })).rejects.toBe(failure); await flush();
  expect(owner.phase).toBe('blocked'); owner.wake(); await flush(); expect(factory).toHaveBeenCalledOnce(); expect(schedule).not.toHaveBeenCalled();
  await owner.disconnect();
});

it('timer cancellation failure is retained as retirement uncertainty and cannot be cleared by Connect', async () => {
  const cleanup = new Error('Timer owner failed'), callbacks: (() => void)[] = [], factory = vi.fn(async () => {
    throw new Error('Transient');
  });
  const owner = new ConnectionMaintenance({
    permits: new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 1 }),
    factory,
    classify: () => 'retry',
    retryDelay: () => 10,
    clock: {
      now: () => 0,
      schedule({ callback }) {
        callbacks.push(callback); return () => {
          throw cleanup;
        };
      },
    },
    changed() {},
  });
  await expect(owner.connect({ mode: 'explicit' })).rejects.toThrow('Transient'); await flush();
  await expect(owner.disconnect()).rejects.toBe(cleanup); callbacks[0]!();
  await expect(owner.connect({ mode: 'explicit' })).rejects.toBe(cleanup); expect(factory).toHaveBeenCalledOnce();
});

it('a thrown failure classifier cannot turn an uncertain failed factory into a retry loop', async () => {
  const classification = new Error('Classifier failed');
  const owner = new ConnectionMaintenance({
    permits: new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 1 }),
    factory: async () => {
      throw new Error('Factory failed');
    },
    classify() {
      throw classification;
    },
    retryDelay: () => 10,
    clock: { now: () => 0, schedule: () => () => {} },
    changed() {},
  });
  await expect(owner.connect({ mode: 'explicit' })).rejects.toBe(classification); await flush();
  await expect(owner.disconnect()).rejects.toBe(classification); await expect(owner.connect({ mode: 'explicit' })).rejects.toBe(classification);
});

it('explicit requests cannot bypass occupied capacity and share their queued outcome', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 2 });
  const background = fixture({ permits }), explicit = fixture({ permits });
  const first = background.owner.connect({ mode: 'background' }); await flush();
  const live = connection({ value: 1, held: true }); background.openings[0]!.result.resolve(live.lease); await first;
  const opening = explicit.owner.connect({ mode: 'explicit' });
  for (let index = 0; index < 100; index++) expect(explicit.owner.connect({ mode: 'explicit' })).toBe(opening);
  await flush(); expect(explicit.factory).not.toHaveBeenCalled(); expect(explicit.owner.phase).toBe('queued');
  const stopping = background.owner.disconnect(); await live.stopped.promise; await flush();
  expect(explicit.factory).not.toHaveBeenCalled();
  live.closed.resolve(); await stopping; await flush(); expect(explicit.factory).toHaveBeenCalledOnce();
  explicit.openings[0]!.result.resolve(connection({ value: 2 }).lease); await opening; await explicit.owner.disconnect();
});

it('promotion changes queue ordering without bypassing a live lease', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 2 });
  const a = fixture({ permits }), b = fixture({ permits }), c = fixture({ permits });
  const first = a.owner.connect({ mode: 'background' }); await flush();
  a.openings[0]!.result.resolve(connection({ value: 1 }).lease); await first;
  const queuedB = b.owner.connect({ mode: 'background' }), queuedC = c.owner.connect({ mode: 'background' });
  expect(c.owner.connect({ mode: 'explicit' })).toBe(queuedC); await flush();
  expect(b.factory).not.toHaveBeenCalled(); expect(c.factory).not.toHaveBeenCalled();
  await a.owner.disconnect(); await flush(); expect(c.factory).toHaveBeenCalledOnce(); expect(b.factory).not.toHaveBeenCalled();
  c.openings[0]!.result.resolve(connection({ value: 3 }).lease); await queuedC; await c.owner.disconnect(); await flush();
  b.openings[0]!.result.resolve(connection({ value: 2 }).lease); await queuedB; await b.owner.disconnect();
});

it('background initiation cannot clear an authority block or change its generation before explicit revalidation', async () => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }); await flush(); state.openings[0]!.result.reject('fatal');
  await expect(first).rejects.toBe('fatal'); await flush(); const token = state.owner.token;
  for (let index = 0; index < 3; index++) await expect(state.owner.connect({ mode: 'background' })).rejects.toBe('fatal');
  state.owner.wake(); await flush(); expect(state.factory).toHaveBeenCalledOnce(); expect(state.owner.token).toBe(token);
  expect(state.owner.blocked).toEqual({ kind: 'terminal', error: 'fatal' });
  const next = state.owner.connect({ mode: 'explicit' }); await flush(); expect(state.factory).toHaveBeenCalledTimes(2); expect(state.owner.token).not.toBe(token);
  state.openings[1]!.result.resolve(connection({ value: 2 }).lease); await next; await state.owner.disconnect();
});

it('explicit promotion survives waiting for an older generation to finish retirement', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 2, maximumWaiting: 4 }), occupied = fixture({ permits }), state = fixture({ permits });
  const holding = occupied.owner.connect({ mode: 'background' }); void holding.catch(() => {}); await flush();
  const old = state.owner.connect({ mode: 'explicit' }); void old.catch(() => {}); await flush();
  const stopping = state.owner.disconnect(), next = state.owner.connect({ mode: 'background' });
  expect(state.owner.connect({ mode: 'explicit' })).toBe(next);
  const late = connection({ value: 1, held: true }); state.openings[0]!.result.resolve(late.lease); await late.stopped.promise;
  expect(state.factory).toHaveBeenCalledOnce(); late.closed.resolve(); await stopping; await flush();
  expect(state.factory).toHaveBeenCalledTimes(2); // The other background owner still holds one of the two leases.
  state.openings[1]!.result.resolve(connection({ value: 2 }).lease); await next;
  const stopHolding = occupied.owner.disconnect(); occupied.openings[0]!.result.resolve(connection({ value: 0 }).lease);
  await Promise.all([stopHolding, state.owner.disconnect()]);
});

it('stale promotion callbacks cannot grant a canceled permit or consume a newer background slot', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 2 });
  const holder = permits.acquire({ signal: new AbortController().signal, mode: 'background' }), releaseHolder = await holder.ready;
  const stop = new AbortController(), old = permits.acquire({ signal: stop.signal, mode: 'background' });
  stop.abort(new Error('Old request canceled')); await expect(old.ready).rejects.toThrow('canceled');
  const current = permits.acquire({ signal: new AbortController().signal, mode: 'background' }); let granted = false;
  void current.ready.then(() => {
    granted = true;
  }); old.promote(); await flush(); expect(granted).toBe(false);
  releaseHolder(); const releaseCurrent = await current.ready; old.promote(); releaseCurrent(); releaseCurrent();
  const probe = permits.acquire({ signal: new AbortController().signal, mode: 'background' }); (await probe.ready)();
});

it('disconnect initiates the returned lease shutdown synchronously and reserves its join before reentry', async () => {
  const state = fixture(), first = state.owner.connect({ mode: 'explicit' }); await flush();
  const gate = Promise.withResolvers<void>(); let reentered: Promise<void> | undefined;
  const retire = vi.fn(() => {
    reentered = state.owner.disconnect(); return gate.promise;
  });
  state.openings[0]!.result.resolve({ value: 1, ended: new Promise(() => {}), retire }); await first;
  const stopping = state.owner.disconnect(); expect(retire).toHaveBeenCalledOnce(); expect(reentered).toBe(stopping);
  gate.resolve(); await stopping;
});

it('a peer close joins the old lease and backs off instead of replacing in a tight loop', async () => {
  const state = fixture();
  const first = state.owner.connect({ mode: 'explicit' }); await flush();
  const old = connection({ value: 1, held: true }); state.openings[0]!.result.resolve(old.lease); await first;
  old.ended.resolve({ error: 'peer closed' }); await old.stopped.promise;
  expect(state.factory).toHaveBeenCalledOnce(); expect(state.timers).toHaveLength(0);
  old.closed.resolve(); await flush(); expect(state.factory).toHaveBeenCalledOnce(); expect(state.timers).toHaveLength(1);
  state.advance({ milliseconds: 10 }); state.timers[0]!.callback(); await flush();
  const next = connection({ value: 2 }); state.openings[1]!.result.resolve(next.lease); await flush();
  expect(state.owner.value).toBe(2); await state.owner.disconnect();
});

it('only a stable live interval resets backoff, not a short connection or slow cleanup', async () => {
  const state = fixture();
  const first = state.owner.connect({ mode: 'explicit' }); await flush();
  state.openings[0]!.result.reject(new Error('offline')); await expect(first).rejects.toThrow('offline'); await flush();
  expect(state.retryDelay).toHaveBeenLastCalledWith({ attempt: 1 });
  state.advance({ milliseconds: 10 }); state.timers.at(-1)!.callback(); await flush();
  const brief = connection({ value: 1, held: true }); state.openings[1]!.result.resolve(brief.lease); await flush();
  state.advance({ milliseconds: 1000 }); brief.ended.resolve({ error: 'offline' }); await brief.stopped.promise;
  state.advance({ milliseconds: 60000 }); brief.closed.resolve(); await flush();
  expect(state.retryDelay).toHaveBeenLastCalledWith({ attempt: 2 });
  state.advance({ milliseconds: 10 }); state.timers.at(-1)!.callback(); await flush();
  const stable = connection({ value: 2 }); state.openings[2]!.result.resolve(stable.lease); await flush();
  state.advance({ milliseconds: 30000 }); stable.ended.resolve({ error: 'offline' }); await flush();
  expect(state.retryDelay).toHaveBeenLastCalledWith({ attempt: 1 }); await state.owner.disconnect();
});

it('continues an authenticated replacement after old wire retirement without releasing its permit or restarting the factory', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 8 });
  const state = fixture({ permits }), pending = Promise.withResolvers<ConnectionReplacement<number>>();
  const old = connection({ value: 1, held: true }), next = connection({ value: 2 });
  let contactSignal: AbortSignal | undefined, finishedSignal: AbortSignal | undefined;
  const prepareReplacement = vi.fn(({ signal }: { signal: AbortSignal }) => {
    contactSignal = signal; return pending.promise;
  });
  const first = state.owner.connect({ mode: 'explicit' }); await flush(); state.openings[0]!.result.resolve({ ...old.lease, prepareReplacement }); await first;
  const token = state.owner.token, other = fixture({ permits }); const waiting = other.owner.connect({ mode: 'explicit' }); void waiting.catch(() => {});
  const finish = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      finishedSignal = signal; return next.lease;
    }), dispose = vi.fn(async () => {});
  pending.resolve({ assertAvailable() {}, finish, dispose }); await old.stopped.promise;
  expect(old.retire).toHaveBeenCalledWith({ replacement: true }); expect(finish).not.toHaveBeenCalled(); expect(other.factory).not.toHaveBeenCalled();
  expect(contactSignal!.aborted).toBe(false);
  old.closed.resolve(); await flush();
  expect(state.owner.value).toBe(2); expect(state.owner.token).not.toBe(token); expect(finishedSignal!.aborted).toBe(false);
  expect(contactSignal!.aborted).toBe(true); expect(state.factory).toHaveBeenCalledOnce(); expect(state.retryDelay).not.toHaveBeenCalled();
  expect(other.factory).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
  await other.owner.disconnect(); await state.owner.disconnect(); expect(next.retire).toHaveBeenCalledOnce();
});

it('joins and disposes a late contact after Disconnect without allowing it to replace the current lease', async () => {
  const state = fixture(), pending = Promise.withResolvers<ConnectionReplacement<number>>();
  const old = connection({ value: 1 }), disposal = Promise.withResolvers<void>();
  const first = state.owner.connect({ mode: 'explicit' }); await flush();
  state.openings[0]!.result.resolve({ ...old.lease, prepareReplacement: () => pending.promise }); await first;
  let stopped = false; const closing = state.owner.disconnect().then(() => {
    stopped = true;
  }); await flush(); expect(stopped).toBe(false);
  const finish = vi.fn(async () => connection({ value: 2 }).lease), dispose = vi.fn(() => disposal.promise);
  pending.resolve({ assertAvailable() {}, finish, dispose }); await flush(); expect(dispose).toHaveBeenCalledOnce(); expect(stopped).toBe(false);
  disposal.resolve(); await closing; expect(finish).not.toHaveBeenCalled(); expect(state.owner.value).toBeUndefined();
});

it('Disconnect during replacement retirement discards the candidate and never starts its continuation', async () => {
  const state = fixture(), old = connection({ value: 1, held: true });
  const finish = vi.fn(async () => connection({ value: 2 }).lease), dispose = vi.fn(async () => {});
  const first = state.owner.connect({ mode: 'explicit' }); await flush();
  state.openings[0]!.result.resolve({ ...old.lease, prepareReplacement: async () => ({ assertAvailable() {}, finish, dispose }) }); await first; await old.stopped.promise;
  const stopped = state.owner.disconnect(); old.closed.resolve(); await stopped;
  expect(finish).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce(); expect(state.owner.phase).toBe('idle');
});

it('authentication failures and same-session confirmations leave the data lease live and rate-limit the next attempt', async () => {
  const state = fixture(), old = connection({ value: 1 }), contact = vi.fn<NonNullable<ConnectionLease<number>['prepareReplacement']>>();
  contact.mockRejectedValueOnce('fatal').mockResolvedValueOnce(undefined).mockImplementation(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const first = state.owner.connect({ mode: 'explicit' }); await flush(); state.openings[0]!.result.resolve({ ...old.lease, prepareReplacement: contact }); await first; await flush();
  expect(state.owner.value).toBe(1); expect(state.owner.blocked).toBeUndefined(); expect(old.retire).not.toHaveBeenCalled(); expect(contact).toHaveBeenCalledOnce();
  expect(state.timers[0]!.milliseconds).toBe(1000); state.advance({ milliseconds: 1000 }); state.timers[0]!.callback(); await flush();
  expect(contact).toHaveBeenCalledTimes(2); expect(old.retire).not.toHaveBeenCalled(); expect(state.timers[1]!.milliseconds).toBe(1000);
  await state.owner.disconnect();
});

it.each([undefined, null, new Error('unclassified cleanup')])('failed late candidate disposal retains ownership even for an opaque error %s', async error => {
  const state = fixture(), old = connection({ value: 1 }), pending = Promise.withResolvers<ConnectionReplacement<number>>();
  const first = state.owner.connect({ mode: 'explicit' }); await flush(); state.openings[0]!.result.resolve({ ...old.lease, prepareReplacement: () => pending.promise }); await first;
  const closing = state.owner.disconnect();
  pending.resolve({ assertAvailable() {}, finish: async () => connection({ value: 2 }).lease, dispose: () => Promise.reject(error) });
  await expect(closing).rejects.toBe(error); expect(state.owner.blocked).toEqual({ kind: 'retirement', error });
  await expect(state.owner.connect({ mode: 'explicit' })).rejects.toBe(error); expect(state.factory).toHaveBeenCalledOnce();
});

it('a continuation returning after cancellation is retired without publishing its RPC value', async () => {
  const state = fixture(), old = connection({ value: 1 }), next = connection({ value: 2, held: true }), pending = Promise.withResolvers<ConnectionLease<number>>();
  const first = state.owner.connect({ mode: 'explicit' }); await flush();
  const finish = vi.fn(() => pending.promise), dispose = vi.fn(async () => {});
  state.openings[0]!.result.resolve({ ...old.lease, prepareReplacement: async () => ({ assertAvailable() {}, finish, dispose }) }); await first; await flush();
  expect(finish).toHaveBeenCalledOnce(); const closing = state.owner.disconnect(); pending.resolve(next.lease); await next.stopped.promise;
  expect(state.owner.value).toBeUndefined(); next.closed.resolve(); await closing; expect(dispose).not.toHaveBeenCalled();
});

it('an expired prepared proposal is disposed without retiring the healthy DATA lease', async () => {
  const state = fixture(), old = connection({ value: 1 }), disposal = Promise.withResolvers<void>();
  const finish = vi.fn(async () => connection({ value: 2 }).lease), dispose = vi.fn(() => disposal.promise);
  const assertAvailable = vi.fn(() => {
    throw new Error('Candidate expired during authority check');
  });
  const first = state.owner.connect({ mode: 'explicit' }); await flush();
  state.openings[0]!.result.resolve({ ...old.lease, prepareReplacement: async () => ({ assertAvailable, finish, dispose }) }); await first; await flush();
  expect(dispose).toHaveBeenCalledOnce(); expect(old.retire).not.toHaveBeenCalled(); expect(state.owner.value).toBe(1);
  disposal.resolve(); await flush(); expect(finish).not.toHaveBeenCalled(); expect(state.timers[0]!.milliseconds).toBe(1000);
  await state.owner.disconnect();
});

it('rechecks candidate eligibility in the adoption turn before stopping old DATA', async () => {
  const state = fixture(), old = connection({ value: 1 });
  const assertAvailable = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => {
    throw new Error('Expired');
  });
  const finish = vi.fn(async () => connection({ value: 2 }).lease), dispose = vi.fn(async () => {});
  const prepareReplacement = vi.fn<NonNullable<ConnectionLease<number>['prepareReplacement']>>().mockResolvedValueOnce({ assertAvailable, finish, dispose }).mockImplementation(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const first = state.owner.connect({ mode: 'explicit' }); await flush(); state.openings[0]!.result.resolve({ ...old.lease, prepareReplacement }); await first; await flush();
  expect(assertAvailable).toHaveBeenCalledTimes(2); expect(dispose).toHaveBeenCalledOnce(); expect(finish).not.toHaveBeenCalled();
  expect(old.retire).not.toHaveBeenCalled(); expect(state.owner.value).toBe(1); await state.owner.disconnect();
});
