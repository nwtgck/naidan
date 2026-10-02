import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function overlappingFlushFixture() {
  const { port, scheduled } = timers();
  const firstFlush = Promise.withResolvers<void>();
  const triggers: string[] = [];
  const value = new HizoFSBackgroundFlushScheduler({
    maximumDirtyAgeMilliseconds: 2_000,
    requestFlush: ({ trigger }) => {
      triggers.push(trigger);
      if (triggers.length === 1) return firstFlush.promise;
      value.markDurable();
      return Promise.resolve();
    },
    timerPort: port,
  });
  value.markDirty({ resourcePressure: true });
  return { firstFlush, scheduled, triggers, value };
}

describe("HizoFS background flush scheduler", () => {
  describe("overlapping epoch delivery", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    it.each([
      { cause: new Error("deferred timer failed"), sink: "observe" },
      { cause: undefined, sink: "observe" },
      { cause: undefined, sink: "throw" },
      { cause: new Error("deferred timer failed without sink"), sink: "absent" },
    ] as const)("fail-stops asynchronous rearming with $sink sink and cause $cause", async ({ cause, sink }) => {
      const { port, scheduled } = timers();
      const firstFlush = Promise.withResolvers<void>();
      const requestFlush = vi.fn(() => firstFlush.promise);
      const onDeferredDeliveryFailure = vi.fn(({ cause: _cause }: { cause: unknown }) => {
        if (sink === "throw") throw new Error("failure sink failed");
      });
      const value = new HizoFSBackgroundFlushScheduler({
        maximumDirtyAgeMilliseconds: 2_000,
        ...(sink === "absent" ? {} : { onDeferredDeliveryFailure }),
        requestFlush,
        timerPort: { schedule: args => {
          if (args.delayMilliseconds === 0) throw cause;
          return port.schedule(args);
        } },
      });
      value.markDirty({ resourcePressure: true });
      value.markDurable();
      value.markDirty({ resourcePressure: false });
      scheduled[0]!.callback();
      firstFlush.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(value.snapshot()).toMatchObject({
        automaticRetryBlocked: true,
        backgroundFlushDeferred: false,
        backgroundFlushInFlight: false,
        backgroundFlushScheduled: false,
        dirty: true,
      });
      expect(onDeferredDeliveryFailure).toHaveBeenCalledTimes(sink === "absent" ? 0 : 1);
      if (sink !== "absent") expect(onDeferredDeliveryFailure).toHaveBeenCalledWith({ cause });
      value.notifyForegroundIdle();
      value.markDirty({ resourcePressure: true });
      expect(scheduled).toHaveLength(1);
      expect(requestFlush).toHaveBeenCalledOnce();
    });

    it.each([false, true])("keeps a new epoch's original age deadline when it expires before completion=%s", async deadlineBeforeCompletion => {
      const { firstFlush, scheduled, triggers, value } = overlappingFlushFixture();
      value.markDurable();
      value.markDirty({ resourcePressure: false });
      value.markDirty({ resourcePressure: false });
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]).toMatchObject({ cancelled: false, delayMilliseconds: 2_000 });
      if (deadlineBeforeCompletion) {
      scheduled[0]!.callback();
      value.markDirty({ resourcePressure: false });
      expect(scheduled).toHaveLength(1);
      expect(value.snapshot().backgroundFlushDeferred).toBe(true);
      }

      firstFlush.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(triggers).toEqual(["resource_pressure"]);
      if (deadlineBeforeCompletion) {
        expect(scheduled).toHaveLength(2);
        expect(scheduled[1]).toMatchObject({ cancelled: false, delayMilliseconds: 0 });
      scheduled[1]!.callback();
      } else {
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]!.cancelled).toBe(false);
      scheduled[0]!.callback();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(triggers).toEqual(["resource_pressure", "dirty_age"]);
      expect(value.snapshot().dirty).toBe(false);
    });

    it.each(["pressure", "age_pending", "age_expired"] as const)("delivers new epoch %s pressure directly from completion without a timer task", async notification => {
      const { firstFlush, scheduled, triggers, value } = overlappingFlushFixture();
      value.markDurable();
      if (notification !== "pressure") {
        value.markDirty({ resourcePressure: false });
        expect(scheduled).toHaveLength(1);
        if (notification === "age_expired") scheduled[0]!.callback();
      }
      value.markDirty({ resourcePressure: true });
      value.markDirty({ resourcePressure: false });
      expect(value.snapshot().backgroundFlushDeferred).toBe(true);
      if (notification === "age_pending") expect(scheduled[0]!.cancelled).toBe(true);
      firstFlush.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(triggers).toEqual(["resource_pressure", "resource_pressure"]);
      expect(scheduled).toHaveLength(notification === "pressure" ? 0 : 1);
      expect(value.snapshot().dirty).toBe(false);
    });

    it.each([false, true])("retains foreground yield for new pressure when idle precedes completion=%s", async idleBeforeCompletion => {
      const { firstFlush, scheduled, triggers, value } = overlappingFlushFixture();
      value.markDurable();
      value.markDirty({ resourcePressure: false });
      value.markDirty({ resourcePressure: true });
      value.deferAfterForegroundBusy({ trigger: "dirty_age" });
      expect(scheduled[0]!.cancelled).toBe(true);
      if (idleBeforeCompletion) value.notifyForegroundIdle();
      firstFlush.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(triggers).toEqual(["resource_pressure"]);
      if (!idleBeforeCompletion) {
        expect(scheduled).toHaveLength(1);
        value.notifyForegroundIdle();
      }
      expect(scheduled).toHaveLength(2);
      expect(scheduled[1]).toMatchObject({ cancelled: false, delayMilliseconds: 0 });
      expect(triggers).toEqual(["resource_pressure"]);
    scheduled[1]!.callback();
    await vi.advanceTimersByTimeAsync(0);
    expect(triggers).toEqual(["resource_pressure", "resource_pressure"]);
    });

    it("does not add timer work for notifications in the same in-flight epoch", async () => {
      const { firstFlush, scheduled, triggers, value } = overlappingFlushFixture();
      value.markDirty({ resourcePressure: false });
      value.markDirty({ resourcePressure: true });
      value.markDirty({ resourcePressure: false });
      expect(scheduled).toHaveLength(0);
      expect(value.snapshot().backgroundFlushDeferred).toBe(false);
      value.markDurable();
      firstFlush.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduled).toHaveLength(0);
      expect(triggers).toEqual(["resource_pressure"]);
    });

    it("cancels a new epoch's age timer while waiting for foreground idle", async () => {
      const { firstFlush, scheduled, triggers, value } = overlappingFlushFixture();
      value.markDurable();
      value.markDirty({ resourcePressure: false });
      value.deferAfterForegroundBusy({ trigger: "dirty_age" });
      expect(scheduled[0]!.cancelled).toBe(true);
    scheduled[0]!.callback();
    firstFlush.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduled).toHaveLength(1);
    expect(triggers).toEqual(["resource_pressure"]);
    value.notifyForegroundIdle();
    expect(scheduled[1]).toMatchObject({ delayMilliseconds: 0 });
    scheduled[1]!.callback();
    await vi.advanceTimersByTimeAsync(0);
    expect(triggers).toEqual(["resource_pressure", "dirty_age"]);
    });

    it.each(["markDurable", "markStalled", "prepareExplicitFlush"] as const)("cancels overlapping delivery on %s without reviving a stale callback", async reset => {
      const { firstFlush, scheduled, triggers, value } = overlappingFlushFixture();
      value.markDurable();
      value.markDirty({ resourcePressure: false });
      expect(scheduled).toHaveLength(1);
      value.markDirty({ resourcePressure: true });
      value[reset]();
    scheduled[0]!.callback();
    firstFlush.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(triggers).toEqual(["resource_pressure"]);
    expect(scheduled).toHaveLength(1);
    expect(value.snapshot()).toMatchObject({
      automaticRetryBlocked: reset === "markStalled",
      backgroundFlushDeferred: false,
      backgroundFlushInFlight: false,
      backgroundFlushScheduled: false,
    });
    });
  });

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
