import { describe, expect, it } from "vitest";
import {
  completeInvestigationCheckpoint,
  createInitialInvestigationCheckpoint,
  interruptInvestigationCheckpoint,
  recordInvestigationEvent,
  replaceInvestigationCheckpointRun,
  TEST_ONLY,
} from "./investigation-recovery";

describe("investigation recovery", () => {
  it("records ordered parent-side events before a Worker returns a run", () => {
    const timestamps = [
      "2026-08-07T00:00:00.000Z",
      "2026-08-07T00:00:01.000Z",
      "2026-08-07T00:00:02.000Z",
    ];
    const now = (): string => timestamps.shift()!;
    const initial = createInitialInvestigationCheckpoint({ modelId: "org/model", runId: "recovery-run", now });
    const first = recordInvestigationEvent({
      checkpoint: initial,
      event: { stepId: "runtime-assets", status: "running", detail: "Importing runtime module" },
      now,
    });
    const second = recordInvestigationEvent({
      checkpoint: first,
      event: { stepId: "runtime-assets", status: "passed", detail: "Runtime verified" },
      now,
    });

    expect(second.recovery).toMatchObject({
      status: "running",
      checkpointSequence: 2,
      totalEventCount: 2,
      droppedEventCount: 0,
      lastEvent: { sequence: 2, detail: "Runtime verified" },
    });
    expect(second.recovery.events.map(event => event.sequence)).toEqual([1, 2]);
    expect(second.run.steps[0]).toEqual({ id: "runtime-assets", status: "passed", detail: "Runtime verified" });
  });

  it("preserves the last complete run while replacing parent checkpoint metadata", () => {
    const timestamps = [
      "2026-08-07T00:00:00.000Z",
      "2026-08-07T00:00:01.000Z",
      "2026-08-07T00:00:02.000Z",
    ];
    const now = (): string => timestamps.shift()!;
    const initial = createInitialInvestigationCheckpoint({ modelId: "org/model", runId: "recovery-run", now });
    const reported = recordInvestigationEvent({
      checkpoint: initial,
      event: { stepId: "runtime-assets", status: "passed", detail: "Runtime verified" },
      now,
    });
    const actualRun = structuredClone(reported.run);
    actualRun.status = "passed";
    actualRun.error = undefined;
    actualRun.currentOperation = "Planning completed";
    const completed = completeInvestigationCheckpoint({
      checkpoint: replaceInvestigationCheckpointRun({ checkpoint: reported, run: actualRun, now }),
      run: actualRun,
      now: () => "2026-08-07T00:00:03.000Z",
    });

    expect(completed.run.currentOperation).toBe("Planning completed");
    expect(completed.recovery.status).toBe("completed");
    expect(completed.recovery.events).toHaveLength(1);
    expect(completed.recovery.totalEventCount).toBe(1);
  });

  it("marks the last running boundary failed and serializes abrupt termination", () => {
    const timestamps = [
      "2026-08-07T00:00:00.000Z",
      "2026-08-07T00:00:01.000Z",
      "2026-08-07T00:00:02.000Z",
    ];
    const now = (): string => timestamps.shift()!;
    const initial = createInitialInvestigationCheckpoint({ modelId: "org/model", runId: "recovery-run", now });
    const reported = recordInvestigationEvent({
      checkpoint: initial,
      event: { stepId: "repository-information", status: "running", detail: "Resolving repository" },
      now,
    });
    const interrupted = interruptInvestigationCheckpoint({
      checkpoint: reported,
      error: new Error("Worker exited unexpectedly"),
      now,
    });

    expect(interrupted.recovery).toMatchObject({
      status: "interrupted",
      interruption: {
        lastEventSequence: 1,
        error: { name: "Error", message: "Worker exited unexpectedly" },
      },
    });
    expect(interrupted.run.currentOperation).toContain("after repository-information: Resolving repository");
    expect(interrupted.run.steps.find(step => step.id === "repository-information")).toEqual({
      id: "repository-information",
      status: "failed",
      detail: "Interrupted: Worker exited unexpectedly",
    });
  });

  it("bounds a hostile progress flood while preserving cumulative counts and semantic boundaries", () => {
    let tick = 0;
    const now = (): string => new Date(tick++).toISOString();
    let checkpoint = createInitialInvestigationCheckpoint({ modelId: "org/model", runId: "stress-run", now });
    checkpoint = recordInvestigationEvent({
      checkpoint,
      event: { stepId: "loading-investigation", status: "running", detail: "Reference load started" },
      now,
    });

    for (let index = 0; index < 10_000; index += 1) {
      checkpoint = recordInvestigationEvent({
        checkpoint,
        event: {
          stepId: "loading-investigation",
          status: "running",
          detail: "webgpu-q4f16: model-load",
          progress: {
            kind: "model-load",
            artifactSource: "downloaded-model-cache",
            candidateId: "webgpu-q4f16",
            sourceStatus: "progress",
            currentFile: `onnx/model_q4f16.onnx_data_${index % 6}`,
            fileLoaded: index,
            fileTotal: 10_000,
            fileProgress: index / 100,
            aggregateLoaded: index,
            aggregateTotal: 10_000,
            aggregateProgress: index / 100,
            eventCount: index + 1,
            progressEventCount: index + 1,
            progressTotalEventCount: 0,
            forwardProgressCount: index + 1,
            repeatedWithoutForwardProgressCount: 0,
            publishedSampleCount: index + 1,
            firstActivityAt: "2026-08-07T00:00:00.000Z",
            lastActivityAt: new Date(index).toISOString(),
            lastForwardProgressAt: new Date(index).toISOString(),
          },
        },
        now,
      });
    }
    checkpoint = recordInvestigationEvent({
      checkpoint,
      event: { stepId: "loading-investigation", status: "passed", detail: "Reference load completed" },
      now,
    });

    expect(checkpoint.recovery.totalEventCount).toBe(10_002);
    expect(checkpoint.recovery.events.length).toBe(TEST_ONLY.MAXIMUM_RETAINED_EVENTS);
    expect(checkpoint.recovery.droppedEventCount).toBe(10_002 - TEST_ONLY.MAXIMUM_RETAINED_EVENTS);
    expect(checkpoint.recovery.events.some(event => event.detail === "Reference load started")).toBe(true);
    expect(checkpoint.recovery.events.at(-1)).toMatchObject({
      sequence: 10_002,
      detail: "Reference load completed",
    });
  });
});
