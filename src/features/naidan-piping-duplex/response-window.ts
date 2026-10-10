import { HandshakeResponseUnconfirmedError } from '@/features/naidan-piping-duplex/lifetime';
import type { HandshakeResponseStage } from '@/features/naidan-piping-duplex/lifetime';

export type ResponseClock = {
  monotonic(): number;
  wall(): number;
  schedule({ milliseconds, callback }: { milliseconds: number; callback(): void }): () => void;
};
export const systemResponseClock: ResponseClock = {
  monotonic: () => performance.now(),
  wall: () => Date.now(),
  schedule({ milliseconds, callback }) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};
export type ResponseWindow = Readonly<{ stage: HandshakeResponseStage; monotonicDeadline: number; wallDeadline: number }>;

/** One candidate owns one current machine-response window. This performs no
 * crypto or transport I/O, and logical failure never claims either has retired. */
export class HandshakeResponses {
  private readonly stop = new AbortController();
  readonly signal: AbortSignal;
  private readonly clock: ResponseClock;
  private readonly milliseconds: number;
  private readonly onFailure: (({ error }: { error: unknown }) => void) | undefined;
  private current: ResponseWindow | undefined;
  private cancelTimer: (() => void) | undefined;
  private timerIdentity: object | undefined;
  private disposed = false;
  private cleanupFailure: { error: unknown } | undefined;

  get retirementFailure(): Readonly<{ error: unknown }> | undefined {
    return this.cleanupFailure;
  }

  private readonly clearOnAbort = () => this.clear();

  constructor({ parent, milliseconds, clock, onFailure }: {
    parent: AbortSignal; milliseconds: number; clock: ResponseClock;
    onFailure: (({ error }: { error: unknown }) => void) | undefined;
  }) {
    if (!Number.isInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2147483647) throw new RangeError('Invalid handshake response budget');
    this.milliseconds = milliseconds; this.clock = clock; this.onFailure = onFailure;
    this.signal = AbortSignal.any([parent, this.stop.signal]);
    this.signal.addEventListener('abort', this.clearOnAbort, { once: true });
    if (this.signal.aborted) this.clear();
  }

  private sample(): { monotonic: number; wall: number } {
    const monotonic = this.clock.monotonic(), wall = this.clock.wall();
    if (!Number.isFinite(monotonic) || !Number.isFinite(wall)) throw new Error('Invalid response clock sample');
    return { monotonic, wall };
  }

  private remaining({ window }: { window: ResponseWindow }): number {
    const now = this.sample();
    return Math.min(window.monotonicDeadline - now.monotonic, window.wallDeadline - now.wall);
  }

  private clear(): void {
    this.current = undefined; this.timerIdentity = undefined;
    const cancel = this.cancelTimer; this.cancelTimer = undefined;
    try {
      cancel?.();
    } catch (error) {
      this.cleanupFailure ??= { error };
    }
  }

  fail({ error }: { error: unknown }): void {
    if (this.signal.aborted || this.disposed) return;
    this.stop.abort(error);
    try {
      this.onFailure?.({ error: this.signal.reason });
    } catch (failure) {
      this.cleanupFailure ??= { error: failure };
    }
  }

  private schedule({ window, milliseconds }: { window: ResponseWindow; milliseconds: number }): void {
    const identity = {}; this.timerIdentity = identity;
    this.cancelTimer = this.clock.schedule({
      milliseconds,
      callback: () => {
        if (this.timerIdentity === identity) this.wake({ window });
      },
    });
  }

  private wake({ window }: { window: ResponseWindow }): void {
    if (this.disposed || this.signal.aborted || this.current !== window) return;
    try {
      const remaining = this.remaining({ window });
      if (remaining <= 0) this.fail({ error: new HandshakeResponseUnconfirmedError({ stage: window.stage }) });
      else this.schedule({ window, milliseconds: Math.max(1, Math.ceil(remaining)) });
    } catch (error) {
      this.fail({ error });
    }
  }

  arm({ stage }: { stage: HandshakeResponseStage }): ResponseWindow {
    this.signal.throwIfAborted();
    if (this.disposed || this.current !== undefined) throw new Error('Response window already active or retired');
    try {
      const now = this.sample(), monotonicDeadline = now.monotonic + this.milliseconds, wallDeadline = now.wall + this.milliseconds;
      if (!Number.isFinite(monotonicDeadline) || !Number.isFinite(wallDeadline) || monotonicDeadline <= now.monotonic || wallDeadline <= now.wall) {
        throw new Error('Unrepresentable response deadline');
      }
      const window = Object.freeze({ stage, monotonicDeadline, wallDeadline });
      this.current = window;
      this.schedule({ window, milliseconds: this.milliseconds });
      return window;
    } catch (error) {
      this.fail({ error });
      throw this.signal.reason;
    }
  }

  /** Recheck after a possibly delayed registration, without accepting any response. */
  check({ window }: { window: ResponseWindow }): boolean {
    this.signal.throwIfAborted();
    if (this.disposed || this.current !== window) return false;
    try {
      if (this.remaining({ window }) <= 0) this.fail({ error: new HandshakeResponseUnconfirmedError({ stage: window.stage }) });
    } catch (error) {
      this.fail({ error });
    }
    this.signal.throwIfAborted();
    return true;
  }

  /** Call only after the expected response's complete crypto/schema validation. */
  accept({ window }: { window: ResponseWindow }): boolean {
    if (!this.check({ window })) return false;
    this.clear(); return true;
  }

  /** Successful disposal clears timers/listeners without aborting a live parent. */
  dispose(): void {
    this.disposed = true; this.clear(); this.signal.removeEventListener('abort', this.clearOnAbort);
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
