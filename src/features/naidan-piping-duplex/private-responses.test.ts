// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { PrivateResponses } from './private-responses';
import { ResponseUnconfirmedError } from './lifetime';

function fixture() {
  const now = { monotonic: 0, wall: 0 }, timers: { callback(): void; milliseconds: number; cancelled: boolean }[] = [];
  const wake = vi.fn(), onFailure = vi.fn();
  const clock = {
    monotonic: () => now.monotonic,
    wall: () => now.wall,
    schedule({ milliseconds, callback }: { milliseconds: number; callback(): void }) {
      const timer = { milliseconds, callback, cancelled: false }; timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  const responses = new PrivateResponses({ policy: { intervalMs: 15_000, responseTimeoutMs: 75_000 }, clock, wake, onFailure });
  return { now, timers, clock, wake, onFailure, responses };
}

it.each([
  { monotonic: 74_999, wall: 74_999, expired: false }, { monotonic: 75_000, wall: 0, expired: true },
  { monotonic: 0, wall: 75_000, expired: true }, { monotonic: 75_001, wall: -900_000, expired: true },
  { monotonic: 1, wall: 900_000, expired: true }, { monotonic: 1, wall: -900_000, expired: false },
])('semantic echo checks immutable dual deadlines $monotonic/$wall', async ({ monotonic, wall, expired }) => {
  const state = fixture(); state.responses.start(); const echo = state.responses.challenge()!;
  state.now.monotonic = monotonic; state.now.wall = wall;
  if (expired) {
    expect(() => state.responses.accept({ echo })).toThrow(ResponseUnconfirmedError);
    await expect(state.responses.ready).rejects.toBeInstanceOf(ResponseUnconfirmedError); expect(state.onFailure).toHaveBeenCalledOnce();
  } else {
    state.responses.accept({ echo }); await state.responses.ready; expect(state.onFailure).not.toHaveBeenCalled();
  }
  state.responses.retire();
});

it.each(['timer-first', 'echo-first'] as const)('expiry wins regardless of resumed callback order: %s', async order => {
  const state = fixture(); state.responses.start(); const echo = state.responses.challenge()!; state.now.wall = 75_000;
  if (order === 'timer-first') state.timers[0]!.callback();
  expect(() => state.responses.accept({ echo })).toThrow(ResponseUnconfirmedError); state.timers[0]!.callback();
  await expect(state.responses.ready).rejects.toBeInstanceOf(ResponseUnconfirmedError);
  expect(state.onFailure).toHaveBeenCalledOnce(); state.responses.retire();
});

it('token fields are owned copies; unrelated receipts, changed tokens and retries never reset expiry', async () => {
  const state = fixture(); state.responses.start(); const original = state.responses.challenge()!, copy = state.responses.challenge()!;
  copy[0]! ^= 1; state.responses.accept({ echo: copy }); state.responses.accept({ echo: undefined });
  expect(state.responses.challenge()).toEqual(original); expect(state.wake).toHaveBeenCalledOnce(); expect(state.timers).toHaveLength(1);
  state.now.monotonic = 75_000;
  expect(() => state.responses.challenge()).toThrow(ResponseUnconfirmedError);
  await expect(state.responses.ready).rejects.toBeInstanceOf(ResponseUnconfirmedError); state.responses.retire();
});

it('interval overdue on resume registers one fresh window at resume, without grace for an existing window', async () => {
  const state = fixture(); state.responses.start(); const first = state.responses.challenge()!;
  state.responses.accept({ echo: first }); await state.responses.ready;
  expect(state.responses.challenge()).toBeUndefined();
  state.now.monotonic = 500_000; state.now.wall = 500_000; state.timers[1]!.callback();
  const second = state.responses.challenge()!; expect(second).not.toEqual(first); expect(state.wake).toHaveBeenCalledTimes(2);
  state.responses.accept({ echo: first }); expect(state.responses.challenge()).toEqual(second);
  state.now.monotonic = 574_999; state.responses.accept({ echo: second });
  expect(state.responses.challenge()).toBeUndefined(); state.responses.retire();
});

it('early and stale timer callbacks cannot extend or cancel a later window', () => {
  const state = fixture(); state.responses.start(); const first = state.responses.challenge()!;
  state.now.monotonic = 1_000; state.now.wall = 1_000; state.timers[0]!.callback();
  expect(state.timers[1]!.milliseconds).toBe(14_000);
  state.responses.accept({ echo: first }); state.now.wall = 16_000; state.timers[2]!.callback();
  const second = state.responses.challenge(); state.timers[0]!.callback(); state.timers[1]!.callback(); state.timers[2]!.callback();
  expect(state.responses.challenge()).toEqual(second); expect(state.onFailure).not.toHaveBeenCalled(); state.responses.retire();
});

it('stop rejects pending readiness and fences late success/timers while retaining the first cause', async () => {
  const state = fixture(); state.responses.start(); const echo = state.responses.challenge(), reason = new Error('Cancelled');
  state.responses.stop({ error: reason }); state.responses.stop({ error: new Error('Later') });
  state.now.wall = 100_000; state.timers[0]!.callback();
  expect(() => state.responses.accept({ echo })).toThrow(reason); await expect(state.responses.ready).rejects.toBe(reason);
  expect(state.onFailure).not.toHaveBeenCalled(); expect(state.timers[0]!.cancelled).toBe(true); state.responses.retire();
});

it.each([0, -1, 1.5, NaN, Infinity, 2147483648])('rejects invalid configuration %s without timers', value => {
  const state = fixture();
  for (const policy of [{ intervalMs: value, responseTimeoutMs: 75_000 }, { intervalMs: 15_000, responseTimeoutMs: value }])
    expect(() => new PrivateResponses({ policy, clock: state.clock, wake: state.wake, onFailure: state.onFailure })).toThrow(RangeError);
  expect(state.timers).toHaveLength(0); state.responses.retire();
});

it.each(['monotonic', 'wall'] as const)('invalid %s clock cannot accept an echo', name => {
  const state = fixture(); state.responses.start(); const echo = state.responses.challenge(); state.now[name] = NaN;
  expect(() => state.responses.accept({ echo })).toThrow('Invalid response clock'); expect(state.onFailure).toHaveBeenCalledOnce(); state.responses.retire();
});

it('throwing failure notification cannot escape timer dispatch or erase timeout', async () => {
  const state = fixture(), cleanup = new Error('Shutdown failed'); state.onFailure.mockImplementation(() => {
    throw cleanup;
  });
  state.responses.start(); state.now.wall = 75_000;
  expect(() => state.timers[0]!.callback()).not.toThrow();
  await expect(state.responses.ready).rejects.toBeInstanceOf(ResponseUnconfirmedError);
  expect(() => state.responses.retire()).toThrow(cleanup);
});

it.each(['monotonic', 'wall'] as const)('unrepresentable %s deadline is a local clock failure, never retryable timeout', name => {
  const state = fixture(); state.now[name] = Number.MAX_VALUE;
  expect(() => state.responses.start()).toThrow('Unrepresentable response deadline');
  const error = state.onFailure.mock.calls[0]![0].error;
  expect(error).not.toBeInstanceOf(ResponseUnconfirmedError); expect(state.timers).toHaveLength(0); state.responses.retire();
});

it('failed first-window timer cancellation rejects readiness and cannot create another timer', async () => {
  const state = fixture(), cleanup = new Error('Timer cancellation failed'), scheduled = vi.fn(() => () => {
    throw cleanup;
  });
  const responses = new PrivateResponses({
    policy: { intervalMs: 15_000, responseTimeoutMs: 75_000 },
    clock: { ...state.clock, schedule: scheduled },
    wake: state.wake,
    onFailure: state.onFailure,
  });
  responses.start(); const echo = responses.challenge();
  expect(() => responses.accept({ echo })).toThrow(cleanup);
  await expect(responses.ready).rejects.toBe(cleanup); expect(scheduled).toHaveBeenCalledOnce();
  expect(state.onFailure).toHaveBeenCalledExactlyOnceWith({ error: cleanup });
  expect(() => responses.retire()).toThrow(cleanup); state.responses.retire();
});

it('health observers cannot throw into protocol state or leave timers after a reentrant stop', async () => {
  const state = fixture(), stopped = new Error('Observer stopped its owner');
  state.responses.subscribe({
    listener: ({ state: health }) => {
      if (health === 'checking') {
        state.responses.stop({ error: stopped }); throw new Error('Observer render failed');
      }
    },
  });
  state.responses.start(); state.now.monotonic = 15000; state.now.wall = 15000;
  expect(() => state.timers[0]!.callback()).not.toThrow();
  await expect(state.responses.ready).rejects.toBe(stopped);
  expect(state.timers).toHaveLength(1); expect(state.onFailure).not.toHaveBeenCalled(); state.responses.retire();
});

it('a warning is observational and never extends the immutable response deadline', async () => {
  const state = fixture(), observed: string[] = [];
  state.responses.subscribe({ listener: ({ state }) => observed.push(state) }); state.responses.start();
  state.now.monotonic = 15000; state.now.wall = 15000; state.timers[0]!.callback();
  expect(observed).toEqual(['healthy', 'checking']); expect(state.timers[1]!.milliseconds).toBe(60000);
  state.now.monotonic = 75000; state.now.wall = 75000; state.timers[1]!.callback();
  await expect(state.responses.ready).rejects.toBeInstanceOf(ResponseUnconfirmedError); expect(state.onFailure).toHaveBeenCalledOnce(); state.responses.retire();
});
