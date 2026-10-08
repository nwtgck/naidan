import { ResponseUnconfirmedError } from '@/features/naidan-piping-duplex/lifetime';
import type { ResponseClock } from '@/features/naidan-piping-duplex/response-window';

export type LivenessPolicy = { intervalMs: number; responseTimeoutMs: number };
type Deadline = { monotonic: number; wall: number };
type Pending = { token: Uint8Array; deadline: Deadline };

/** One private response window per connection. No caller probes or HTTP owner. */
export class PrivateResponses {
  private readonly first = Promise.withResolvers<void>();
  readonly ready = this.first.promise;
  private readonly clock: ResponseClock;
  private readonly policy: LivenessPolicy;
  private readonly wake: () => void;
  private readonly onFailure: ({ error }: { error: unknown }) => void;
  private pending: Pending | undefined;
  private next: Deadline | undefined;
  private timer: { identity: object; cancel(): void } | undefined;
  private started = false;
  private stopped: { error: unknown } | undefined;
  private cleanupFailure: { error: unknown } | undefined;

  constructor({ policy, clock, wake, onFailure }: {
    policy: LivenessPolicy; clock: ResponseClock; wake(): void; onFailure({ error }: { error: unknown }): void;
  }) {
    const { intervalMs, responseTimeoutMs, ...rest } = policy; rest satisfies Record<PropertyKey, never>;
    for (const value of [intervalMs, responseTimeoutMs]) {
      if (!Number.isInteger(value) || value <= 0 || value > 2147483647) throw new RangeError('Invalid liveness policy');
    }
    this.policy = { intervalMs, responseTimeoutMs }; this.clock = clock; this.wake = wake; this.onFailure = onFailure;
    void this.ready.catch(() => {});
  }
  private sample(): Deadline {
    const monotonic = this.clock.monotonic(), wall = this.clock.wall();
    if (!Number.isFinite(monotonic) || !Number.isFinite(wall)) throw new Error('Invalid response clock sample');
    return { monotonic, wall };
  }
  private deadline({ milliseconds }: { milliseconds: number }): Deadline {
    const now = this.sample(), monotonic = now.monotonic + milliseconds, wall = now.wall + milliseconds;
    if (!Number.isFinite(monotonic) || !Number.isFinite(wall) || monotonic <= now.monotonic || wall <= now.wall)
      throw new Error('Unrepresentable response deadline');
    return { monotonic, wall };
  }
  private remaining({ deadline }: { deadline: Deadline }): number {
    const now = this.sample(); return Math.min(deadline.monotonic - now.monotonic, deadline.wall - now.wall);
  }
  private clearTimer(): { error: unknown } | undefined {
    const timer = this.timer; this.timer = undefined;
    try {
      timer?.cancel();
    } catch (error) {
      this.cleanupFailure ??= { error }; return this.cleanupFailure;
    }
    return undefined;
  }
  private fail({ error }: { error: unknown }): void {
    if (this.stopped) return;
    this.stop({ error });
    try {
      this.onFailure({ error });
    } catch (failure) {
      this.cleanupFailure ??= { error: failure };
    }
  }
  private schedule({ deadline }: { deadline: Deadline }): void {
    const cleanup = this.clearTimer();
    if (cleanup) {
      this.fail({ error: cleanup.error }); throw cleanup.error;
    }
    const identity = {};
    const callback = () => {
      if (this.stopped || this.timer?.identity !== identity) return;
      this.timer = undefined;
      try {
        const remaining = this.remaining({ deadline });
        if (remaining > 0) {
          this.schedule({ deadline }); return;
        }
        if (this.pending?.deadline === deadline) this.fail({ error: new ResponseUnconfirmedError() });
        else if (this.next === deadline) this.register();
      } catch (error) {
        this.fail({ error });
      }
    };
    this.timer = { identity, cancel: this.clock.schedule({ milliseconds: Math.max(1, this.remaining({ deadline })), callback }) };
  }
  private register(): void {
    if (this.stopped) return;
    const token = crypto.getRandomValues(new Uint8Array(32));
    const deadline = this.deadline({ milliseconds: this.policy.responseTimeoutMs });
    this.pending = { token, deadline }; this.next = undefined;
    this.schedule({ deadline }); this.wake();
  }
  start(): void {
    if (this.started || this.stopped) throw new Error('Response owner already started or stopped');
    this.started = true;
    try {
      this.register();
    } catch (error) {
      this.fail({ error }); throw error;
    }
  }
  /** Copies are captured before seal; registration/expiry never waits for seal or POST. */
  challenge(): Uint8Array | undefined {
    this.check(); return this.pending?.token.slice();
  }
  private check(): void {
    if (this.stopped) throw this.stopped.error;
    try {
      if (this.pending && this.remaining({ deadline: this.pending.deadline }) <= 0) throw new ResponseUnconfirmedError();
    } catch (error) {
      this.fail({ error }); throw error;
    }
  }
  /** Only call after authenticated record number and all payload semantics commit. */
  accept({ echo }: { echo: Uint8Array | undefined }): void {
    this.check();
    const pending = this.pending;
    if (pending && echo !== undefined && sameToken({ left: pending.token, right: echo })) {
      this.pending = undefined;
      const cleanup = this.clearTimer();
      if (cleanup) {
        this.fail({ error: cleanup.error }); throw cleanup.error;
      }
      this.first.resolve();
      try {
        this.next = this.deadline({ milliseconds: this.policy.intervalMs }); this.schedule({ deadline: this.next });
      } catch (error) {
        this.fail({ error }); throw error;
      }
    }
  }

  stop({ error }: { error: unknown }): void {
    if (this.stopped) return;
    this.stopped = { error }; this.pending = undefined; this.next = undefined;
    this.clearTimer(); this.first.reject(error);
  }
  retire(): void {
    this.stop({ error: new Error('Response owner retired') });
    if (this.cleanupFailure) throw this.cleanupFailure.error;
  }
}
function sameToken({ left, right }: { left: Uint8Array; right: Uint8Array }): boolean {
  if (left.length !== 32 || right.length !== 32) return false;
  let difference = 0; for (let index = 0; index < 32; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
