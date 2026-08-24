import { describe, expect, it, vi } from "vitest";
import {
  ProductionLaneTimeoutError,
  withProductionLaneTimeout,
} from "./production-lane-timeout";

describe("withProductionLaneTimeout", () => {
  it("returns an operation that finishes before the deadline", async () => {
    await expect(withProductionLaneTimeout({
      operation: Promise.resolve("done"),
      timeoutMs: 10,
      timeoutError: () => new ProductionLaneTimeoutError({ stage: "first-turn", timeoutMs: 10 }),
      onTimeout: vi.fn(),
    })).resolves.toBe("done");
  });

  it("rejects with the last Production stage and invokes the timeout callback", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const assertion = expect(withProductionLaneTimeout({
        operation: new Promise<string>(() => undefined),
        timeoutMs: 5,
        timeoutError: () => new ProductionLaneTimeoutError({ stage: "tool-result-continuation", timeoutMs: 5 }),
        onTimeout,
      })).rejects.toMatchObject({
        name: "ProductionLaneTimeoutError",
        stage: "tool-result-continuation",
        timeoutMs: 5,
      });
      await vi.advanceTimersByTimeAsync(5);
      await assertion;
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
