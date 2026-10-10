// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { HandshakeResponses } from '@/features/naidan-piping-duplex/response-window';
import { HandshakeResponseUnconfirmedError } from '@/features/naidan-piping-duplex/lifetime';

function fixture() {
  const now = { monotonic: 0, wall: 0 }, pending: { callback(): void; milliseconds: number; cancelled: boolean }[] = [];
  const parent = new AbortController(), onFailure = vi.fn();
  const clock = {
    monotonic: () => now.monotonic,
    wall: () => now.wall,
    schedule({ milliseconds, callback }: { milliseconds: number; callback(): void }) {
      const task = { milliseconds, callback, cancelled: false }; pending.push(task);
      return () => {
        task.cancelled = true;
      };
    },
  };
  const responses = new HandshakeResponses({ parent: parent.signal, milliseconds: 75_000, clock, onFailure });
  return { now, pending, parent, onFailure, clock, responses };
}

it.each([
  { monotonic: 74_999, wall: 74_999, expired: false }, { monotonic: 75_000, wall: 0, expired: true },
  { monotonic: 0, wall: 75_000, expired: true }, { monotonic: 75_001, wall: -900_000, expired: true },
  { monotonic: 1, wall: 900_000, expired: true }, { monotonic: 1, wall: -900_000, expired: false },
])('checks both clock deadlines at semantic acceptance: $monotonic/$wall', ({ monotonic, wall, expired }) => {
  const state = fixture(), window = state.responses.arm({ stage: 'confirmation' });
  state.now.monotonic = monotonic; state.now.wall = wall;
  if (expired) {
    expect(() => state.responses.accept({ window })).toThrow(HandshakeResponseUnconfirmedError);
    expect(state.onFailure).toHaveBeenCalledOnce();
  } else {
    expect(state.responses.accept({ window })).toBe(true); expect(state.parent.signal.aborted).toBe(false);
    expect(state.onFailure).not.toHaveBeenCalled();
  }
  state.responses.dispose();
});

it.each(['timer-first', 'commit-first'] as const)('expired callbacks are order independent: %s', order => {
  const state = fixture(), window = state.responses.arm({ stage: 'noise-2' });
  state.now.wall = 100_000;
  if (order === 'timer-first') state.pending[0]!.callback();
  expect(() => state.responses.accept({ window })).toThrow(HandshakeResponseUnconfirmedError);
  state.pending[0]!.callback(); expect(state.onFailure).toHaveBeenCalledOnce();
  state.responses.dispose();
});

it('early timer wake rearms only remaining time and preserves the original deadlines', () => {
  const state = fixture(), window = state.responses.arm({ stage: 'status' });
  state.now.monotonic = 1_000; state.now.wall = 1_000; state.pending[0]!.callback();
  state.pending[0]!.callback(); expect(state.pending).toHaveLength(2);
  expect(state.pending[1]!.milliseconds).toBe(74_000); expect(window.monotonicDeadline).toBe(75_000);
  state.now.monotonic = 75_000; state.pending[1]!.callback();
  expect(state.onFailure).toHaveBeenCalledOnce(); state.responses.dispose();
});

it('stale stage/candidate callbacks cannot abort a newer response window', () => {
  const state = fixture(), old = state.responses.arm({ stage: 'noise-2' });
  expect(state.responses.accept({ window: old })).toBe(true);
  const current = state.responses.arm({ stage: 'status' });
  state.now.wall = 75_000; state.pending[0]!.callback();
  expect(state.responses.signal.aborted).toBe(false);
  expect(state.responses.accept({ window: old })).toBe(false);
  expect(() => state.responses.accept({ window: current })).toThrow(HandshakeResponseUnconfirmedError);
  const other = fixture(), fresh = other.responses.arm({ stage: 'seed' });
  expect(other.responses.accept({ window: old })).toBe(false);
  expect(other.responses.accept({ window: fresh })).toBe(true); state.responses.dispose(); other.responses.dispose();
});

it('parent cancellation wins over late timeout and success disposal never aborts parent', () => {
  const state = fixture(), window = state.responses.arm({ stage: 'seed' }), error = new Error('Caller cancelled');
  state.parent.abort(error); state.now.wall = 900_000; state.pending[0]!.callback();
  expect(() => state.responses.accept({ window })).toThrow(error); expect(state.onFailure).not.toHaveBeenCalled();
  state.responses.dispose(); expect(state.pending[0]!.cancelled).toBe(true);
  const success = fixture(); success.responses.dispose(); expect(success.parent.signal.aborted).toBe(false);
});

it.each([0, -1, NaN, Infinity, 1.5, 2147483648])('rejects invalid response budget %s before scheduling', milliseconds => {
  const state = fixture();
  expect(() => new HandshakeResponses({ parent: state.parent.signal, milliseconds, clock: state.clock, onFailure: undefined })).toThrow(RangeError);
  expect(state.pending).toHaveLength(0); state.responses.dispose();
});

it.each(['monotonic', 'wall'] as const)('invalid %s samples cannot pass semantic acceptance', clock => {
  const state = fixture(), window = state.responses.arm({ stage: 'confirmation' }); state.now[clock] = NaN;
  expect(() => state.responses.accept({ window })).toThrow('Invalid response clock');
  expect(state.responses.signal.aborted).toBe(true); expect(state.responses.signal.reason).not.toBeInstanceOf(HandshakeResponseUnconfirmedError);
  state.responses.dispose();
});

it('a throwing shutdown callback preserves logical timeout and records retirement failure', () => {
  const state = fixture(), cleanup = new Error('Shutdown callback failed'); state.onFailure.mockImplementation(() => {
    throw cleanup;
  });
  state.responses.arm({ stage: 'status' }); state.now.wall = 75_000;
  expect(() => state.pending[0]!.callback()).not.toThrow();
  expect(state.responses.signal.reason).toBeInstanceOf(HandshakeResponseUnconfirmedError);
  expect(state.responses.retirementFailure).toEqual({ error: cleanup });
  state.responses.dispose();
});

it.each([NaN, Infinity, Number.MAX_VALUE])('rejects invalid or unrepresentable arm clocks %s without creating an immortal window', monotonic => {
  const state = fixture(); state.now.monotonic = monotonic;
  expect(() => state.responses.arm({ stage: 'status' })).toThrow();
  expect(state.responses.signal.aborted).toBe(true); expect(state.pending).toHaveLength(0);
  state.responses.dispose();
});
