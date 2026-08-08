import { describe, expect, it } from "vitest";
import {
  HizoFSBackgroundFlushScheduler,
  type HizoFSBackgroundFlushTimerPort,
} from "@/00-storage/service/hizofs/runtime/background-flush-scheduler";

function timers() {
  const scheduled: Array<{
    callback: () => void;
    cancelled: boolean;
    delayMilliseconds: number;
  }> = [];
  const port: HizoFSBackgroundFlushTimerPort = {
    schedule: ({ callback, delayMilliseconds }) => {
      const entry = { callback, cancelled: false, delayMilliseconds };
      scheduled.push(entry);
      return { cancel: () => {
        entry.cancelled = true;
      } };
    },
  };
  return { port, scheduled };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("HizoFS background flush scheduler", () => {
  it("keeps the first dirty deadline instead of postponing it per mutation", async () => {
    const { port, scheduled } = timers();
    const triggers: string[] = [];
    const value = new HizoFSBackgroundFlushScheduler({
      maximumDirtyAgeMilliseconds: 2_000,
      requestFlush: async ({ trigger }) => {
        triggers.push(trigger);
      },
      timerPort: port,
    });

    value.markDirty({ resourcePressure: false });
    value.markDirty({ resourcePressure: false });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ cancelled: false, delayMilliseconds: 2_000 });
    expect(value.snapshot().scheduledTrigger).toBe("dirty_age");

    scheduled[0]!.callback();
    await flushMicrotasks();
    expect(triggers).toEqual(["dirty_age"]);
    expect(value.snapshot().backgroundFlushScheduled).toBe(false);
  });

  it("starts resource-pressure publication before a caller can enter the next mutation", async () => {
    const { port, scheduled } = timers();
    const triggers: string[] = [];
    let releaseFlush!: () => void;
    const flushReleased = new Promise<void>(resolve => {
      releaseFlush = resolve;
    });
    const value = new HizoFSBackgroundFlushScheduler({
      maximumDirtyAgeMilliseconds: 2_000,
      requestFlush: async ({ trigger }) => {
        triggers.push(trigger);
        await flushReleased;
      },
      timerPort: port,
    });

    value.markDirty({ resourcePressure: false });
    value.markDirty({ resourcePressure: true });
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.cancelled).toBe(true);
    expect(triggers).toEqual(["resource_pressure"]);
    expect(value.snapshot()).toMatchObject({
      backgroundFlushInFlight: true,
      backgroundFlushScheduled: false,
      scheduledTrigger: null,
    });

    scheduled[0]!.callback();
    releaseFlush();
    await flushMicrotasks();
    expect(triggers).toEqual(["resource_pressure"]);
  });

  it("defers a foreground-busy timer without rearming until foreground admission closes", async () => {
    const { port, scheduled } = timers();
    let attempt = 0;
    const value = new HizoFSBackgroundFlushScheduler({
      maximumDirtyAgeMilliseconds: 2_000,
      requestFlush: async ({ trigger }) => {
        attempt += 1;
        if (attempt === 1) value.deferAfterForegroundBusy({ trigger });
        else value.markDurable();
      },
      timerPort: port,
    });

    value.markDirty({ resourcePressure: false });
    scheduled[0]!.callback();
    await flushMicrotasks();
    expect(attempt).toBe(1);
    expect(scheduled).toHaveLength(1);
    expect(value.snapshot()).toMatchObject({
      backgroundFlushDeferred: true,
      backgroundFlushScheduled: false,
      dirty: true,
    });

    value.notifyForegroundIdle();
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1]).toMatchObject({ delayMilliseconds: 0 });
    scheduled[1]!.callback();
    await flushMicrotasks();
    expect(attempt).toBe(2);
    expect(value.snapshot()).toMatchObject({
      backgroundFlushDeferred: false,
      dirty: false,
    });
  });

  it("blocks automatic retry after failure until explicit durability succeeds", async () => {
    const { port, scheduled } = timers();
    const failure = new Error("background publication failed");
    const value = new HizoFSBackgroundFlushScheduler({
      maximumDirtyAgeMilliseconds: 2_000,
      requestFlush: async () => {
        value.markStalled();
        throw failure;
      },
      timerPort: port,
    });

    value.markDirty({ resourcePressure: false });
    scheduled[0]!.callback();
    await flushMicrotasks();
    expect(value.snapshot()).toMatchObject({
      automaticRetryBlocked: true,
      dirty: true,
    });

    value.markDirty({ resourcePressure: true });
    expect(scheduled).toHaveLength(1);
    value.markDurable();
    value.markDirty({ resourcePressure: false });
    expect(scheduled).toHaveLength(2);
  });

  it("cancels the background timer when explicit sync upgrades the flush", () => {
    const { port, scheduled } = timers();
    const value = new HizoFSBackgroundFlushScheduler({
      maximumDirtyAgeMilliseconds: 2_000,
      requestFlush: async () => undefined,
      timerPort: port,
    });

    value.markDirty({ resourcePressure: false });
    value.prepareExplicitFlush();
    expect(scheduled[0]!.cancelled).toBe(true);
    expect(value.snapshot()).toMatchObject({
      backgroundFlushScheduled: false,
      dirty: true,
    });
  });
});
