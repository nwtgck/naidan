import { describe, expect, it, vi } from "vitest";

import { BackgroundWorkCoordinator } from "./background-work-coordinator";

function createIdlePlatform() {
  let now = 0;
  let nextHandle = 1;
  const idleCallbacks = new Map<number, () => void>();
  const cancelledIdleHandles: number[] = [];

  return {
    platform: {
      now: () => now,
      requestIdle: ({ callback }: { callback: () => void }) => {
        const handle = nextHandle;
        nextHandle += 1;
        idleCallbacks.set(handle, () => {
          idleCallbacks.delete(handle);
          callback();
        });
        return handle;
      },
      cancelIdle: ({ handle }: { handle: number }) => {
        cancelledIdleHandles.push(handle);
        idleCallbacks.delete(handle);
      },
      setTimer: ({ callback, delayMs }: { callback: () => void, delayMs: number }) => {
        return setTimeout(callback, delayMs);
      },
      clearTimer: ({ handle }: { handle: ReturnType<typeof setTimeout> }) => clearTimeout(handle),
    },
    idleCallbacks,
    cancelledIdleHandles,
    setNow: ({ value }: { value: number }) => {
      now = value;
    },
  };
}

describe("BackgroundWorkCoordinator", () => {
  it("runs one background step per idle grant and removes completed work", async () => {
    const { platform, idleCallbacks } = createIdlePlatform();
    const coordinator = new BackgroundWorkCoordinator({ platform, quietWindowMs: 250 });
    const runStep = vi.fn()
      .mockResolvedValueOnce({ status: "continue" as const })
      .mockResolvedValueOnce({ status: "done" as const });

    coordinator.register({ runStep });
    expect(idleCallbacks.size).toBe(1);

    idleCallbacks.values().next().value?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(idleCallbacks.size).toBe(1);

    idleCallbacks.values().next().value?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(idleCallbacks.size).toBe(0);
  });

  it("cancels a pending grant while foreground work is active", () => {
    const { platform, idleCallbacks, cancelledIdleHandles } = createIdlePlatform();
    const coordinator = new BackgroundWorkCoordinator({ platform, quietWindowMs: 250 });
    coordinator.register({ runStep: async () => ({ status: "continue" }) });
    expect(idleCallbacks.size).toBe(1);

    const lease = coordinator.beginForegroundWork();
    expect(cancelledIdleHandles).toHaveLength(1);
    expect(idleCallbacks.size).toBe(0);

    lease.dispose();
    expect(idleCallbacks.size).toBe(1);
  });

  it("round-robins continuing work across idle grants", async () => {
    const { platform, idleCallbacks } = createIdlePlatform();
    const coordinator = new BackgroundWorkCoordinator({ platform, quietWindowMs: 250 });
    const order: string[] = [];
    coordinator.register({
      runStep: async () => {
        order.push("first");
        return { status: "continue" };
      },
    });
    coordinator.register({
      runStep: async () => {
        order.push("second");
        return { status: "continue" };
      },
    });

    idleCallbacks.values().next().value?.();
    await Promise.resolve();
    await Promise.resolve();
    idleCallbacks.values().next().value?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(["first", "second"]);
  });

  it("does not schedule another grant while foreground work starts during an active step", async () => {
    const { platform, idleCallbacks } = createIdlePlatform();
    const coordinator = new BackgroundWorkCoordinator({ platform, quietWindowMs: 250 });
    let finishStep: (() => void) | undefined;
    const stepFinished = new Promise<void>(resolve => {
      finishStep = resolve;
    });
    coordinator.register({
      runStep: async () => {
        await stepFinished;
        return { status: "continue" };
      },
    });

    idleCallbacks.values().next().value?.();
    await Promise.resolve();
    const foreground = coordinator.beginForegroundWork();
    finishStep?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(idleCallbacks.size).toBe(0);

    foreground.dispose();
    expect(idleCallbacks.size).toBe(1);
  });

  it("starts the fallback quiet window when the first background work is registered", () => {
    let now = 1_000;
    let timerDelayMs: number | undefined;
    const platform = {
      now: () => now,
      requestIdle: undefined,
      cancelIdle: undefined,
      setTimer: ({ delayMs }: { callback: () => void, delayMs: number }) => {
        timerDelayMs = delayMs;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    };
    const coordinator = new BackgroundWorkCoordinator({ platform, quietWindowMs: 250 });

    now = 5_000;
    coordinator.register({ runStep: async () => ({ status: "done" }) });

    expect(timerDelayMs).toBe(250);
  });

  it("resets the fallback quiet window after foreground activity", async () => {
    let now = 0;
    let timerCallback: (() => void) | undefined;
    let timerDelayMs: number | undefined;
    let timerCancelled = false;
    const platform = {
      now: () => now,
      requestIdle: undefined,
      cancelIdle: undefined,
      setTimer: ({ callback, delayMs }: { callback: () => void, delayMs: number }) => {
        timerCallback = callback;
        timerDelayMs = delayMs;
        timerCancelled = false;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {
        timerCancelled = true;
        timerCallback = undefined;
      },
    };
    const coordinator = new BackgroundWorkCoordinator({ platform, quietWindowMs: 250 });
    const runStep = vi.fn().mockResolvedValue({ status: "done" as const });

    coordinator.register({ runStep });
    expect(timerDelayMs).toBe(250);

    now = 200;
    coordinator.markForegroundActivity();
    expect(timerCancelled).toBe(false);
    expect(timerDelayMs).toBe(250);

    now = 449;
    const beforeQuiet = timerCallback;
    beforeQuiet?.();
    expect(runStep).not.toHaveBeenCalled();
    expect(timerDelayMs).toBe(1);

    now = 450;
    timerCallback?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(runStep).toHaveBeenCalledTimes(1);
  });
});
