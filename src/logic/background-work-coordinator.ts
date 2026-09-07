export type BackgroundWorkStepResult =
  | { status: "continue" }
  | { status: "done" };

export interface BackgroundWorkRegistration {
  dispose(): void,
}

export interface ForegroundWorkLease {
  dispose(): void,
}

type ScheduledTask = {
  cancel(): void,
};

type BackgroundWorkPlatform = {
  now(): number,
  requestIdle: (({ callback }: { callback: () => void }) => number) | undefined,
  cancelIdle: (({ handle }: { handle: number }) => void) | undefined,
  setTimer({ callback, delayMs }: { callback: () => void, delayMs: number }): ReturnType<typeof setTimeout>,
  clearTimer({ handle }: { handle: ReturnType<typeof setTimeout> }): void,
};

type RegisteredBackgroundWork = {
  id: number,
  runStep(): Promise<BackgroundWorkStepResult>,
};

export class BackgroundWorkCoordinator {
  private readonly work = new Map<number, RegisteredBackgroundWork>();
  private nextWorkId = 1;
  private scheduledTask: ScheduledTask | undefined;
  private running = false;
  private foregroundWorkCount = 0;
  private lastForegroundActivityAt: number;

  constructor({ platform, quietWindowMs }: {
    platform: BackgroundWorkPlatform,
    quietWindowMs: number,
  }) {
    this.platform = platform;
    this.quietWindowMs = quietWindowMs;
    this.lastForegroundActivityAt = platform.now();
  }

  private readonly platform: BackgroundWorkPlatform;
  private readonly quietWindowMs: number;

  register({ runStep }: {
    runStep(): Promise<BackgroundWorkStepResult>,
  }): BackgroundWorkRegistration {
    const id = this.nextWorkId;
    this.nextWorkId += 1;
    const registered: RegisteredBackgroundWork = { id, runStep };
    const wasEmpty = this.work.size === 0;
    this.work.set(id, registered);
    if (wasEmpty) {
      this.lastForegroundActivityAt = this.platform.now();
    }
    this.scheduleNext();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.work.delete(id);
        if (this.work.size === 0) {
          this.cancelScheduledTask();
        }
      },
    };
  }

  beginForegroundWork(): ForegroundWorkLease {
    this.foregroundWorkCount += 1;
    this.markForegroundActivity();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        this.foregroundWorkCount -= 1;
        this.lastForegroundActivityAt = this.platform.now();
        this.scheduleNext();
      },
    };
  }

  markForegroundActivity(): void {
    this.lastForegroundActivityAt = this.platform.now();
    this.cancelScheduledTask();
    this.scheduleNext();
  }

  private cancelScheduledTask(): void {
    this.scheduledTask?.cancel();
    this.scheduledTask = undefined;
  }

  private scheduleNext(): void {
    if (
      this.scheduledTask !== undefined
      || this.running
      || this.foregroundWorkCount !== 0
      || this.work.size === 0
    ) {
      return;
    }

    if (this.platform.requestIdle !== undefined && this.platform.cancelIdle !== undefined) {
      const handle = this.platform.requestIdle({
        callback: () => {
          this.scheduledTask = undefined;
          void this.runNext();
        },
      });
      this.scheduledTask = {
        cancel: () => this.platform.cancelIdle?.({ handle }),
      };
      return;
    }

    const scheduleTimer = (): void => {
      const quietForMs = this.platform.now() - this.lastForegroundActivityAt;
      const remainingQuietMs = Math.max(0, this.quietWindowMs - quietForMs);
      const handle = this.platform.setTimer({
        delayMs: remainingQuietMs,
        callback: () => {
          this.scheduledTask = undefined;
          const currentQuietForMs = this.platform.now() - this.lastForegroundActivityAt;
          if (currentQuietForMs < this.quietWindowMs || this.foregroundWorkCount !== 0) {
            this.scheduleNext();
            return;
          }
          void this.runNext();
        },
      });
      this.scheduledTask = {
        cancel: () => this.platform.clearTimer({ handle }),
      };
    };
    scheduleTimer();
  }

  private async runNext(): Promise<void> {
    if (this.running || this.foregroundWorkCount !== 0) {
      this.scheduleNext();
      return;
    }
    const registered = this.work.values().next().value as RegisteredBackgroundWork | undefined;
    if (registered === undefined) {
      return;
    }

    this.running = true;
    try {
      const result = await registered.runStep();
      if (this.work.get(registered.id) !== registered) {
        return;
      }
      switch (result.status) {
      case "continue":
        this.work.delete(registered.id);
        this.work.set(registered.id, registered);
        break;
      case "done":
        this.work.delete(registered.id);
        break;
      default: {
        const _ex: never = result;
        throw new Error(`Unhandled background work result: ${JSON.stringify(_ex)}`);
      }
      }
    } catch (error: unknown) {
      this.work.delete(registered.id);
      console.error("Background work failed", error);
    } finally {
      this.running = false;
      this.lastForegroundActivityAt = this.platform.now();
      this.scheduleNext();
    }
  }
}

const defaultPlatform: BackgroundWorkPlatform = {
  now: () => Date.now(),
  requestIdle: typeof globalThis.requestIdleCallback === "function"
    ? ({ callback }) => globalThis.requestIdleCallback(() => callback())
    : undefined,
  cancelIdle: typeof globalThis.cancelIdleCallback === "function"
    ? ({ handle }) => globalThis.cancelIdleCallback(handle)
    : undefined,
  setTimer: ({ callback, delayMs }) => globalThis.setTimeout(callback, delayMs),
  clearTimer: ({ handle }) => globalThis.clearTimeout(handle),
};

export const backgroundWorkCoordinator = new BackgroundWorkCoordinator({
  platform: defaultPlatform,
  quietWindowMs: 250,
});

if (typeof window !== "undefined") {
  const markActivity = () => backgroundWorkCoordinator.markForegroundActivity();
  for (const eventName of ["pointerdown", "keydown", "wheel", "touchstart"] as const) {
    window.addEventListener(eventName, markActivity, { capture: true, passive: true });
  }
}

export const TEST_ONLY = {
  defaultPlatform,
};
