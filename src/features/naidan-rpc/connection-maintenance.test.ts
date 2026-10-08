// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { ConnectionMaintenance, ConnectionOpenPermits } from './connection-maintenance';
import type { ConnectionLease, MaintenanceFailure } from './connection-maintenance';

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
  const owner = new ConnectionMaintenance({
    permits,
    factory,
    classify,
    retryDelay: () => 10,
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

it('the shared opening cap is four and canceled queued attempts do not consume a later permit', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 4, maximumWaiting: 32 }), states = Array.from({ length: 6 }, () => fixture({ permits }));
  const requests = states.map(state => state.owner.connect({ mode: 'background' })); for (const request of requests) void request.catch(() => {}); await flush();
  expect(states.map(state => state.factory.mock.calls.length)).toEqual([1, 1, 1, 1, 0, 0]);
  await states[4]!.owner.disconnect();
  const live = connection({ value: 0 }); states[0]!.openings[0]!.result.resolve(live.lease); await requests[0]; await flush();
  expect(states[4]!.factory).not.toHaveBeenCalled(); expect(states[5]!.factory).toHaveBeenCalledOnce();
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

it('explicit action bypasses four untimed background openings and repeated requests remain coalesced', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 4, maximumWaiting: 32 }), background = Array.from({ length: 4 }, () => fixture({ permits }));
  const requests = background.map(state => state.owner.connect({ mode: 'background' })); for (const request of requests) void request.catch(() => {});
  await flush(); const explicit = fixture({ permits }), opening = explicit.owner.connect({ mode: 'explicit' });
  for (let index = 0; index < 100; index++) expect(explicit.owner.connect({ mode: 'explicit' })).toBe(opening);
  await flush(); expect(explicit.factory).toHaveBeenCalledOnce();
  const live = connection({ value: 9 }); explicit.openings[0]!.result.resolve(live.lease); await opening;
  live.ended.resolve({ error: 'transient' }); await flush(); explicit.advance({ milliseconds: 10 }); explicit.timers[0]!.callback(); await flush();
  expect(explicit.factory).toHaveBeenCalledOnce(); // Its later automatic retry uses background admission.
  const all = [...background, explicit], closing = all.map(state => state.owner.disconnect());
  for (const state of background) state.openings[0]!.result.resolve(connection({ value: 0 }).lease);
  await Promise.all(closing);
});

it('manual promotion of a queued background attempt shares its existing outcome and starts one factory', async () => {
  const permits = new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 2 }), a = fixture({ permits }), b = fixture({ permits });
  const first = a.owner.connect({ mode: 'background' }); void first.catch(() => {}); await flush();
  const queued = b.owner.connect({ mode: 'background' }); await flush(); expect(b.factory).not.toHaveBeenCalled();
  expect(b.owner.connect({ mode: 'explicit' })).toBe(queued); await flush(); expect(b.factory).toHaveBeenCalledOnce();
  const live = connection({ value: 2 }); b.openings[0]!.result.resolve(live.lease); await queued;
  const closingA = a.owner.disconnect(); a.openings[0]!.result.resolve(connection({ value: 1 }).lease);
  await Promise.all([closingA, b.owner.disconnect()]);
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
  const permits = new ConnectionOpenPermits({ capacity: 1, maximumWaiting: 4 }), occupied = fixture({ permits }), state = fixture({ permits });
  const holding = occupied.owner.connect({ mode: 'background' }); void holding.catch(() => {}); await flush();
  const old = state.owner.connect({ mode: 'explicit' }); void old.catch(() => {}); await flush();
  const stopping = state.owner.disconnect(), next = state.owner.connect({ mode: 'background' });
  expect(state.owner.connect({ mode: 'explicit' })).toBe(next);
  const late = connection({ value: 1, held: true }); state.openings[0]!.result.resolve(late.lease); await late.stopped.promise;
  expect(state.factory).toHaveBeenCalledOnce(); late.closed.resolve(); await stopping; await flush();
  expect(state.factory).toHaveBeenCalledTimes(2); // Unrelated background discovery still holds its permit.
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
