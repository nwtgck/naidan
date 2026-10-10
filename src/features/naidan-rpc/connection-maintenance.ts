import { deferred } from '@/features/naidan-rpc/primitives';

export type ConnectionReplacement<Value> = {
  /** Synchronous final check before the live DATA lease is stopped. */
  assertAvailable(): void;
  /** Continues the already-authenticated candidate after the old wire retires. */
  finish({ signal }: { signal: AbortSignal }): Promise<ConnectionLease<Value>>;
  dispose(): Promise<void>;
};
export type ConnectionLease<Value> = {
  readonly value: Value;
  readonly ended: Promise<Readonly<{ error: unknown }>>;
  /** Initiates shutdown immediately, then joins every resource owned by this lease. */
  retire({ replacement }: { replacement: boolean }): Promise<void>;
  /** One authentication attempt; undefined means keep the existing connection. */
  prepareReplacement?({ signal }: { signal: AbortSignal }): Promise<ConnectionReplacement<Value> | undefined>;
};
export type MaintenanceClock = {
  now(): number;
  /** Schedules asynchronously; never invokes callback before returning its cancel handle. */
  schedule({ milliseconds, callback }: { milliseconds: number; callback(): void }): () => void;
};
export const maintenanceClock: MaintenanceClock = {
  now: () => performance.now(),
  schedule({ milliseconds, callback }) {
    const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer);
  },
};
export type MaintenanceFailure = 'retry' | 'blocked' | 'retirement-failed';
export type MaintenancePhase = 'idle' | 'queued' | 'opening' | 'connected' | 'retiring' | 'backoff' | 'blocked';
type Block = Readonly<{ kind: 'terminal' | 'retirement'; error: unknown }>;
type Request<Value> = { generation: number; result: ReturnType<typeof deferred<Value>>; settled: boolean };
type PermitAdmission = { ready: Promise<() => void>; promote(): void };
export type ConnectionInitiation = 'explicit' | 'background';
type Slot<Value> = {
  mode: ConnectionInitiation; admission: PermitAdmission | undefined;
  generation: number; binding: object; stop: AbortController; retired: ReturnType<typeof deferred<void>>;
  lease: ConnectionLease<Value> | undefined; retirement: Promise<void> | undefined;
};

/** A hard bound for complete connection lifetimes, including queued explicit
 * requests. Promotion changes ordering only; it cannot create extra capacity. */
export class ConnectionOpenPermits {
  private readonly capacity: number;
  private readonly maximumWaiting: number;
  private active = 0;
  private readonly waiting: { signal: AbortSignal; mode: ConnectionInitiation; grant(): void; cancel(): void }[] = [];

  constructor({ capacity, maximumWaiting }: { capacity: number; maximumWaiting: number }) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(maximumWaiting) || maximumWaiting < 0)
      throw new RangeError('Invalid connection capacity');
    this.capacity = capacity; this.maximumWaiting = maximumWaiting;
  }

  get idle(): boolean {
    return this.active === 0 && this.waiting.length === 0;
  }

  acquire({ signal, mode }: { signal: AbortSignal; mode: ConnectionInitiation }): PermitAdmission {
    signal.throwIfAborted();
    if (this.active >= this.capacity && this.waiting.length >= this.maximumWaiting)
      throw new Error('Connection opening queue is full');
    const result = deferred<() => void>(); let pending = true;
    const remove = () => {
      const index = this.waiting.indexOf(request); if (index >= 0) this.waiting.splice(index, 1);
      signal.removeEventListener('abort', request.cancel);
    };
    const request = {
      signal,
      mode,
      grant: () => {
        if (!pending) return; pending = false; remove(); this.active++;
        let held = true; result.resolve(() => {
          if (!held) return; held = false; this.active--; this.drain();
        });
      },
      cancel: () => {
        if (!pending) return; pending = false; remove(); result.reject(signal.reason);
      },
    };
    signal.addEventListener('abort', request.cancel, { once: true });
    if (signal.aborted) request.cancel();
    else {
      this.waiting.push(request); this.drain();
    }
    return {
      ready: result.promise,
      promote: () => {
        if (!pending) return;
        if (signal.aborted) request.cancel();
        else {
          request.mode = 'explicit'; this.drain();
        }
      },
    };
  }

  private drain(): void {
    while (this.active < this.capacity && this.waiting.length) {
      const request = this.waiting.find(request => isExplicit({ mode: request.mode })) ?? this.waiting[0]!;
      if (request.signal.aborted) request.cancel(); else request.grant();
    }
  }
}

/** One runtime desire and one owned attempt/connection slot. The factory is
 * responsible for fresh authority validation and joining failed establishment;
 * a failure that cannot prove retirement must be classified retirement-failed. */
export class ConnectionMaintenance<Value> {
  private readonly permits: Pick<ConnectionOpenPermits, 'acquire'>;
  private readonly factory: ({ signal, mode }: { signal: AbortSignal; mode: ConnectionInitiation }) => Promise<ConnectionLease<Value>>;
  private readonly classify: ({ error, source }: { error: unknown; source: 'factory' | 'connection' }) => MaintenanceFailure;
  private readonly retryDelay: ({ attempt }: { attempt: number }) => number;
  private readonly clock: MaintenanceClock;
  private readonly changed: () => void;
  private desired: 'connected' | 'disconnected' = 'disconnected';
  private generation = 0;
  private intentToken: object = {};
  private slot: Slot<Value> | undefined;
  private request: Request<Value> | undefined;
  private blockState: Block | undefined;
  private status: MaintenancePhase = 'idle';
  private timer: { identity: object; generation: number; deadline: number; cancel(): void } | undefined;
  private attempts = 0;
  private nextMode: ConnectionInitiation = 'background';

  constructor({ factory, classify, retryDelay, clock, changed, permits }: {
    permits: Pick<ConnectionOpenPermits, 'acquire'>;
    factory({ signal, mode }: { signal: AbortSignal; mode: ConnectionInitiation }): Promise<ConnectionLease<Value>>;
    classify({ error, source }: { error: unknown; source: 'factory' | 'connection' }): MaintenanceFailure;
    retryDelay({ attempt }: { attempt: number }): number;
    clock: MaintenanceClock; changed(): void;
  }) {
    this.permits = permits; this.factory = factory; this.classify = classify; this.retryDelay = retryDelay; this.clock = clock; this.changed = changed;
  }

  get desiredConnection(): 'connected' | 'disconnected' {
    return this.desired;
  }

  get phase(): MaintenancePhase {
    return this.status;
  }

  get blocked(): Block | undefined {
    return this.blockState;
  }

  get value(): Value | undefined {
    return this.isConnected() ? this.slot?.lease?.value : undefined;
  }

  get token(): object {
    return this.slot?.generation === this.generation ? this.slot.binding : this.intentToken;
  }

  private isConnected(): boolean {
    const phase = this.status;
    switch (phase) {
    case 'connected': return true;
    case 'idle': case 'queued': case 'opening': case 'retiring': case 'backoff': case 'blocked': return false;
    default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
    }
  }

  private retirementBlock(): Block | undefined {
    const block = this.blockState; if (!block) return undefined;
    switch (block.kind) {
    case 'retirement': return block;
    case 'terminal': return undefined;
    default: { const exhaustive: never = block.kind; throw new Error(String(exhaustive)); }
    }
  }

  private notify(): void {
    try {
      this.changed();
    } catch { /* Observation cannot own connection resources. */ }
  }

  private rejectRequest({ error }: { error: unknown }): void {
    if (this.request && !this.request.settled) {
      this.request.settled = true; this.request.result.reject(error);
    }
  }

  private failRetirement({ error }: { error: unknown }): void {
    if (this.retirementBlock()) return;
    this.blockState = Object.freeze({ kind: 'retirement', error }); this.status = 'blocked';
    this.rejectRequest({ error }); this.notify();
  }

  private clearTimer(): boolean {
    const timer = this.timer; this.timer = undefined;
    try {
      timer?.cancel(); return true;
    } catch (error) {
      this.failRetirement({ error }); return false;
    }
  }

  /** Explicit desire. Returns this attempt's result; a retryable failure can
   * reject it while the runtime desire remains connected for future attempts. */
  connect({ mode }: { mode: ConnectionInitiation }): Promise<Value> {
    if (!isExplicit({ mode }) && this.blockState) return Promise.reject(this.blockState.error);
    if (isExplicit({ mode })) {
      if (this.slot && !this.slot.stop.signal.aborted) {
        this.slot.mode = 'explicit'; this.slot.admission?.promote();
      } else if (this.request && !this.request.settled) this.nextMode = 'explicit';
    }
    if (this.retirementBlock()) {
      this.desired = 'connected'; this.notify(); return Promise.reject(this.blockState?.error);
    }
    if (this.desired === 'connected' && !this.blockState && this.request && !this.request.settled) return this.request.result.promise;
    if (this.desired === 'connected' && !this.blockState && this.slot && !this.slot.stop.signal.aborted) {
      if (this.isConnected() && this.slot.lease) return Promise.resolve(this.slot.lease.value);
      if (!this.request || this.request.settled) this.request = { generation: this.generation, result: deferred<Value>(), settled: false };
      return this.request.result.promise;
    }
    this.desired = 'connected'; this.generation++; this.intentToken = {}; this.attempts = 0; this.nextMode = mode;
    this.blockState = undefined;
    if (!this.clearTimer()) return Promise.reject(this.blocked?.error);
    const request = { generation: this.generation, result: deferred<Value>(), settled: false }; this.request = request;
    this.notify(); this.start(); return request.result.promise;
  }

  disconnect(): Promise<void> {
    this.desired = 'disconnected'; this.generation++; this.intentToken = {};
    const slot = this.slot, error = new Error('Connection desire cancelled');
    this.rejectRequest({ error }); this.clearTimer();
    if (!this.blockState) this.status = slot ? 'retiring' : 'idle';
    slot?.stop.abort(error); if (slot) this.beginRetirement({ slot }); this.notify();
    return slot?.retired.promise ?? (this.retirementBlock() ? Promise.reject(this.blockState?.error) : Promise.resolve());
  }

  /** Authority invalidation retains desire, but only explicit revalidation may
   * clear an ordinary terminal block. Passive wakeups never clear blocks. */
  block({ error }: { error: unknown }): Promise<void> {
    if (this.retirementBlock()) return Promise.reject(this.blockState?.error);
    this.generation++; this.intentToken = {}; this.blockState = Object.freeze({ kind: 'terminal', error });
    this.rejectRequest({ error }); this.clearTimer(); this.status = 'blocked';
    const slot = this.slot; slot?.stop.abort(error); if (slot) this.beginRetirement({ slot }); this.notify();
    return slot?.retired.promise ?? (this.retirementBlock() ? Promise.reject(this.blockState?.error) : Promise.resolve());
  }

  wake(): void {
    this.start();
  }

  private current({ slot }: { slot: Slot<Value> }): boolean {
    return this.slot === slot && slot.generation === this.generation && this.desired === 'connected' && !slot.stop.signal.aborted && !this.blockState;
  }

  private start(): void {
    if (this.desired !== 'connected' || this.slot || this.timer || this.blockState) return;
    const slot: Slot<Value> = { mode: this.nextMode, admission: undefined, generation: this.generation, binding: {}, stop: new AbortController(), retired: deferred<void>(), lease: undefined, retirement: undefined };
    this.nextMode = 'background'; this.slot = slot; this.status = 'queued'; this.notify();
    void this.run({ slot });
  }

  private decision({ error, source }: { error: unknown; source: 'factory' | 'connection' }): MaintenanceFailure {
    try {
      const decision = this.classify({ error, source });
      switch (decision) {
      case 'retry': case 'blocked': case 'retirement-failed': return decision;
      default: { const exhaustive: never = decision; throw new Error(String(exhaustive)); }
      }
    } catch (failure) {
      this.failRetirement({ error: failure }); return 'retirement-failed';
    }
  }

  private async run({ slot }: { slot: Slot<Value> }): Promise<void> {
    let release: (() => void) | undefined;
    let outcome: { error: unknown; decision: MaintenanceFailure } | undefined;
    try {
      // A synchronous observer can cancel before the factory starts. Once it
      // starts, never race away its promise: it may return a late live resource.
      slot.stop.signal.throwIfAborted();
      slot.admission = this.permits.acquire({ signal: slot.stop.signal, mode: slot.mode });
      release = await slot.admission.ready;
      slot.stop.signal.throwIfAborted();
      this.status = 'opening'; this.notify(); slot.stop.signal.throwIfAborted();
      slot.lease = await this.factory({ signal: slot.stop.signal, mode: slot.mode });
      void slot.lease.ended.catch(() => {});
      while (this.current({ slot })) {
        const connectedAt = this.clock.now();
        this.status = 'connected';
        const request = this.request;
        if (request && !request.settled && request.generation === slot.generation) {
          request.settled = true; request.result.resolve(slot.lease!.value);
        }
        this.notify();
        if (this.current({ slot })) {
          const update = await this.waitForUpdate({ slot, lease: slot.lease! });
          if (!update) break;
          switch (update.kind) {
          case 'replacement': {
            let consumed = false;
            try {
              if (!this.current({ slot })) break;
              try {
                update.candidate.assertAvailable();
              } catch (error) {
                if (this.contactRetirementFailed({ error })) throw error;
                continue; // An expired proposal cannot terminate the live lease.
              }
              this.status = 'retiring'; this.notify();
              // Keep the intent scope and its permit. Only the old DATA lease
              // retires; aborting the slot here would destroy the candidate.
              this.beginRetirement({ slot, replacement: true }); await slot.retirement;
              if (!this.current({ slot })) break;
              slot.lease = undefined; slot.retirement = undefined; slot.binding = {};
              this.status = 'opening'; this.notify();
              slot.stop.signal.throwIfAborted();
              consumed = true; slot.lease = await update.candidate.finish({ signal: slot.stop.signal });
              void slot.lease.ended.catch(() => {});
            } finally {
              try {
                if (!consumed) await this.disposeCandidate({ candidate: update.candidate });
              } finally {
                update.stop();
              }
            }
            continue;
          }
          case 'ended': {
            if (this.current({ slot })) {
              const connectedFor = this.clock.now() - connectedAt;
              if (Number.isFinite(connectedFor) && connectedFor >= 30000) this.attempts = 0;
              outcome = { error: update.error, decision: this.decision({ error: update.error, source: 'connection' }) };
            }
            break;
          }
          default: { const exhaustive: never = update; throw new Error(String(exhaustive)); }
          }
          break;
        }
      }
    } catch (error) {
      const decision = this.decision({ error, source: slot.lease ? 'connection' : 'factory' });
      if (decision === 'retirement-failed' || this.current({ slot })) outcome = { error, decision };
      if (this.request?.generation === slot.generation) this.rejectRequest({ error });
    }
    if (!this.blockState) this.status = 'retiring';
    slot.stop.abort(outcome?.error); this.notify();
    let retirement: { error: unknown } | undefined;
    try {
      this.beginRetirement({ slot }); await slot.retirement;
    } catch (error) {
      retirement = { error };
    }
    if (retirement || outcome?.decision === 'retirement-failed' || this.retirementBlock()) {
      const error = this.retirementBlock() ? this.blockState?.error : retirement ? retirement.error : outcome?.error;
      if (!this.retirementBlock()) this.failRetirement({ error });
      slot.retired.reject(error); return; // Keep the failed ownership slot; no replacement loop.
    }
    release?.();
    if (this.slot === slot) this.slot = undefined;
    slot.retired.resolve();
    if (slot.generation === this.generation && this.desired === 'connected' && !this.blockState) {
      const decision = outcome?.decision;
      switch (decision) {
      case 'blocked': this.blockState = Object.freeze({ kind: 'terminal', error: outcome?.error }); this.status = 'blocked'; break;
      case 'retry': this.scheduleRetry(); break;
      case undefined: this.start(); break;
      default: { const exhaustive: never = decision; throw new Error(String(exhaustive)); }
      }
    } else if (!this.blockState) {
      this.status = 'idle'; this.start();
    }
    this.notify();
  }

  private beginRetirement({ slot, replacement = false }: { slot: Slot<Value>; replacement?: boolean }): void {
    if (!slot.lease || slot.retirement) return;
    // Reserve the join before shutdown can synchronously reenter the owner.
    const retiring = deferred<void>(); slot.retirement = retiring.promise;
    try {
      Promise.resolve(slot.lease.retire({ replacement })).then(retiring.resolve, retiring.reject);
    } catch (error) {
      retiring.reject(error);
    }
  }

  private async waitForUpdate({ slot, lease }: { slot: Slot<Value>; lease: ConnectionLease<Value> }): Promise<
    | { kind: 'ended'; error: unknown }
    | { kind: 'replacement'; candidate: ConnectionReplacement<Value>; stop(): void }
    | undefined
  > {
    const stopped = deferred<undefined>(), cancel = () => stopped.resolve(undefined);
    slot.stop.signal.addEventListener('abort', cancel, { once: true }); if (slot.stop.signal.aborted) cancel();
    const contactStop = new AbortController(), signal = AbortSignal.any([slot.stop.signal, contactStop.signal]);
    const contact = lease.prepareReplacement ? (async () => {
      for (;;) {
        signal.throwIfAborted(); const started = this.clock.now();
        if (!Number.isFinite(started)) throw new Error('Invalid contact clock');
        try {
          const candidate = await lease.prepareReplacement!({ signal });
          if (candidate) {
            try {
              candidate.assertAvailable();
            } catch (error) {
              await this.disposeCandidate({ candidate }); throw error;
            }
            return { kind: 'replacement' as const, candidate, stop: () => contactStop.abort() };
          }
        } catch (error) {
          if (signal.aborted || this.contactRetirementFailed({ error })) throw error;
          // Unauthenticated input cannot terminate the current data connection.
        }
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            try {
              cancelTimer();
            } catch (error) {
              this.failRetirement({ error }); reject(error); return;
            }
            reject(signal.reason);
          };
          const cancelTimer = this.clock.schedule({
            milliseconds: Math.max(1, Math.ceil(1000 - (this.clock.now() - started))),
            callback: () => {
              signal.removeEventListener('abort', abort); resolve();
            },
          });
          signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        });
      }
    })() : undefined;
    let result: { kind: 'ended'; error: unknown } | { kind: 'replacement'; candidate: ConnectionReplacement<Value>; stop(): void } | undefined;
    let failure: { error: unknown } | undefined;
    try {
      result = await Promise.race([
        lease.ended.then(({ error }) => ({ kind: 'ended' as const, error })), stopped.promise,
        ...(contact ? [contact] : []),
      ]);
    } catch (error) {
      failure = { error };
    }
    slot.stop.signal.removeEventListener('abort', cancel);
    if (result) {
      switch (result.kind) {
      case 'replacement': return result;
      case 'ended': break;
      default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
      }
    }
    contactStop.abort();
    // The losing operation can return late. It remains owned until disposal.
    let late: Awaited<NonNullable<typeof contact>> | undefined;
    try {
      late = await contact;
    } catch (error) {
      if (this.contactRetirementFailed({ error })) failure = { error };
    }
    if (late) await this.disposeCandidate({ candidate: late.candidate });
    if (failure) throw failure.error;
    return result;
  }

  private contactRetirementFailed({ error }: { error: unknown }): boolean {
    const decision = this.decision({ error, source: 'connection' });
    switch (decision) {
    case 'retirement-failed': return true;
    case 'retry': case 'blocked': return false;
    default: { const exhaustive: never = decision; throw new Error(String(exhaustive)); }
    }
  }

  private async disposeCandidate({ candidate }: { candidate: ConnectionReplacement<Value> }): Promise<void> {
    try {
      await candidate.dispose();
    } catch (error) {
      // Disposal failure is ownership failure, independent of retryable peer errors.
      this.failRetirement({ error }); throw error;
    }
  }

  private scheduleRetry(): void {
    if (this.desired !== 'connected' || this.slot || this.blockState || this.timer) return;
    try {
      this.attempts = Math.min(Number.MAX_SAFE_INTEGER, this.attempts + 1);
      const milliseconds = this.retryDelay({ attempt: this.attempts }), now = this.clock.now(), deadline = now + milliseconds;
      if (!Number.isInteger(milliseconds) || milliseconds <= 0 || milliseconds > 2147483647 || !Number.isFinite(now) || !Number.isFinite(deadline) || deadline <= now)
        throw new Error('Invalid connection retry policy or clock');
      this.armRetry({ deadline, generation: this.generation });
    } catch (error) {
      if (!this.blockState) this.blockState = Object.freeze({ kind: 'terminal', error }); this.status = 'blocked';
    }
  }

  private armRetry({ deadline, generation }: { deadline: number; generation: number }): void {
    const identity = {}, remaining = deadline - this.clock.now();
    if (!Number.isFinite(remaining)) throw new Error('Invalid connection retry clock');
    this.status = 'backoff';
    const callback = () => {
      if (this.timer?.identity !== identity || generation !== this.generation) return;
      this.timer = undefined;
      try {
        const now = this.clock.now(); if (!Number.isFinite(now)) throw new Error('Invalid connection retry clock');
        if (now < deadline) this.armRetry({ deadline, generation }); else this.start();
      } catch (error) {
        this.blockState = Object.freeze({ kind: 'terminal', error }); this.status = 'blocked'; this.notify();
      }
    };
    const cancel = this.clock.schedule({ milliseconds: Math.max(1, Math.min(2147483647, remaining)), callback });
    this.timer = { identity, generation, deadline, cancel };
  }
}

function isExplicit({ mode }: { mode: ConnectionInitiation }): boolean {
  switch (mode) {
  case 'explicit': return true;
  case 'background': return false;
  default: { const exhaustive: never = mode; throw new Error(String(exhaustive)); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
