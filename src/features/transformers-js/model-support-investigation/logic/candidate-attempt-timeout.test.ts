import { describe, expect, it, vi } from "vitest";
import {
  CandidateAttemptTimeoutError,
  withCandidateAttemptTimeout,
} from "@/features/transformers-js/model-support-investigation/logic/candidate-attempt-timeout";

describe("withCandidateAttemptTimeout", () => {
  it("rejects with the last observed stage and runs the timeout cleanup", async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const operation = withCandidateAttemptTimeout({
        operation: new Promise<never>(() => undefined),
        timeoutMs: 5,
        timeoutError: () => new CandidateAttemptTimeoutError({
          stage: "model-load",
          events: [{
            stage: "model-load",
            status: "running",
            detail: "loading",
            at: "now",
          }],
          timeoutMs: 5,
        }),
        onTimeout,
      });
      const assertion = expect(operation).rejects.toMatchObject({
        name: "CandidateAttemptTimeoutError",
        stage: "model-load",
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
