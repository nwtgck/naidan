export type HizoFSBackgroundFlushTrigger =
  | "dirty_age"
  | "resource_pressure";

export type HizoFSBackgroundFlushTimer = Readonly<{
  cancel: () => void;
}>;

export type HizoFSBackgroundFlushTimerPort = Readonly<{
  schedule: ({ callback, delayMilliseconds }: {
    callback: () => void;
    delayMilliseconds: number;
  }) => HizoFSBackgroundFlushTimer;
}>;

export type HizoFSBackgroundFlushSchedulerSnapshot = Readonly<{
  automaticRetryBlocked: boolean;
  backgroundFlushDeferred: boolean;
  backgroundFlushInFlight: boolean;
  backgroundFlushScheduled: boolean;
  dirty: boolean;
  scheduledTrigger: HizoFSBackgroundFlushTrigger | null;
}>;

const DEFAULT_BACKGROUND_FLUSH_TIMER_PORT: HizoFSBackgroundFlushTimerPort = Object.freeze({
  schedule: ({ callback, delayMilliseconds }) => {
    const handle = globalThis.setTimeout(callback, delayMilliseconds);
    return Object.freeze({ cancel: () => globalThis.clearTimeout(handle) });
  },
});

/**
 * Owns one bounded background-flush timer for a runtime dirty epoch. The first
 * dirty mutation fixes the age deadline; later mutations cannot postpone it.
 * A resource-pressure trigger may only move the same timer earlier. Automatic
 * failure is fail-stopped until an explicit flush succeeds, preventing retry
 * storms from hiding a durable-publication failure.
 */
export class HizoFSBackgroundFlushScheduler {
  #automaticRetryBlocked = false;
  #backgroundFlushInFlight = false;
  #deferredTrigger: HizoFSBackgroundFlushTrigger | undefined;
  #deferredUntilForegroundIdle = false;
  #dirty = false;
  readonly #maximumDirtyAgeMilliseconds: number;
  readonly #requestFlush: ({ trigger }: {
    trigger: HizoFSBackgroundFlushTrigger;
  }) => Promise<void>;
  #scheduled: Readonly<{
    timer: HizoFSBackgroundFlushTimer;
    trigger: HizoFSBackgroundFlushTrigger;
  }> | undefined;
  readonly #timerPort: HizoFSBackgroundFlushTimerPort;

  constructor({ maximumDirtyAgeMilliseconds, requestFlush, timerPort = DEFAULT_BACKGROUND_FLUSH_TIMER_PORT }: {
    maximumDirtyAgeMilliseconds: number;
    requestFlush: ({ trigger }: { trigger: HizoFSBackgroundFlushTrigger }) => Promise<void>;
    timerPort?: HizoFSBackgroundFlushTimerPort;
  }) {
    if (!Number.isSafeInteger(maximumDirtyAgeMilliseconds) || maximumDirtyAgeMilliseconds < 1) {
      throw new TypeError("maximum dirty age must be a positive safe integer");
    }
    this.#maximumDirtyAgeMilliseconds = maximumDirtyAgeMilliseconds;
    this.#requestFlush = requestFlush;
    this.#timerPort = timerPort;
  }

  #cancelScheduled(): void {
    const scheduled = this.#scheduled;
    if (scheduled === undefined) return;
    this.#scheduled = undefined;
    scheduled.timer.cancel();
  }

  #schedule({ delayMilliseconds, trigger }: {
    delayMilliseconds: number;
    trigger: HizoFSBackgroundFlushTrigger;
  }): void {
    const scheduled = Object.freeze({
      timer: this.#timerPort.schedule({
        callback: () => {
          if (this.#scheduled !== scheduled) return;
          this.#scheduled = undefined;
          if (!this.#dirty || this.#automaticRetryBlocked || this.#backgroundFlushInFlight) return;
          this.#backgroundFlushInFlight = true;
          void this.#requestFlush({ trigger }).catch(() => undefined).finally(() => {
            this.#backgroundFlushInFlight = false;
            this.#scheduleDeferredIfReady();
          });
        },
        delayMilliseconds,
      }),
      trigger,
    });
    this.#scheduled = scheduled;
  }

  #deferTrigger({ trigger }: { trigger: HizoFSBackgroundFlushTrigger }): void {
    const current = this.#deferredTrigger;
    if (current === undefined) {
      this.#deferredTrigger = trigger;
      return;
    }
    switch (current) {
    case "resource_pressure": return;
    case "dirty_age":
      this.#deferredTrigger = trigger;
      return;
    default: return current satisfies never;
    }
  }

  #scheduleDeferredIfReady(): void {
    const trigger = this.#deferredTrigger;
    if (
      trigger === undefined
      || !this.#dirty
      || this.#automaticRetryBlocked
      || this.#backgroundFlushInFlight
      || this.#deferredUntilForegroundIdle
      || this.#scheduled !== undefined
    ) return;
    this.#deferredTrigger = undefined;
    this.#schedule({ delayMilliseconds: 0, trigger });
  }

  deferAfterForegroundBusy({ trigger }: { trigger: HizoFSBackgroundFlushTrigger }): void {
    if (!this.#dirty || this.#automaticRetryBlocked) return;
    this.#deferredUntilForegroundIdle = true;
    this.#deferTrigger({ trigger });
  }

  notifyForegroundIdle(): void {
    this.#deferredUntilForegroundIdle = false;
    this.#scheduleDeferredIfReady();
  }

  markDirty({ resourcePressure }: { resourcePressure: boolean }): void {
    this.#dirty = true;
    if (this.#automaticRetryBlocked || this.#backgroundFlushInFlight) return;
    const scheduled = this.#scheduled;
    if (resourcePressure) {
      if (scheduled !== undefined) {
        switch (scheduled.trigger) {
        case "resource_pressure": return;
        case "dirty_age": break;
        default: return scheduled.trigger satisfies never;
        }
      }
      this.#cancelScheduled();
      this.#schedule({ delayMilliseconds: 0, trigger: "resource_pressure" });
      return;
    }
    if (scheduled !== undefined) return;
    this.#schedule({
      delayMilliseconds: this.#maximumDirtyAgeMilliseconds,
      trigger: "dirty_age",
    });
  }

  markDurable(): void {
    this.#cancelScheduled();
    this.#deferredTrigger = undefined;
    this.#deferredUntilForegroundIdle = false;
    this.#automaticRetryBlocked = false;
    this.#dirty = false;
  }

  markStalled(): void {
    this.#cancelScheduled();
    this.#deferredTrigger = undefined;
    this.#deferredUntilForegroundIdle = false;
    this.#automaticRetryBlocked = true;
    this.#dirty = true;
  }

  prepareExplicitFlush(): void {
    this.#cancelScheduled();
    this.#deferredTrigger = undefined;
    this.#deferredUntilForegroundIdle = false;
  }

  snapshot(): HizoFSBackgroundFlushSchedulerSnapshot {
    return Object.freeze({
      automaticRetryBlocked: this.#automaticRetryBlocked,
      backgroundFlushDeferred: this.#deferredTrigger !== undefined,
      backgroundFlushInFlight: this.#backgroundFlushInFlight,
      backgroundFlushScheduled: this.#scheduled !== undefined,
      dirty: this.#dirty,
      scheduledTrigger: this.#scheduled?.trigger ?? null,
    });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
