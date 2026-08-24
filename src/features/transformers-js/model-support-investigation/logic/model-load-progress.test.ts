import { describe, expect, it } from "vitest";
import { createModelLoadProgressTracker } from "@/features/transformers-js/model-support-investigation/logic/model-load-progress";

describe("createModelLoadProgressTracker", () => {
  it("collapses the Transformers.js progress_total/progress pair into stable load diagnostics", () => {
    const tracker = createModelLoadProgressTracker({ candidateId: "webgpu-q4f16" });

    const total = tracker.observe({
      info: { status: "progress_total", loaded: 10, total: 100, progress: 10 },
      at: "2026-08-07T07:00:00.000Z",
      nowMs: 0,
    });
    const file = tracker.observe({
      info: { status: "progress", file: "model.onnx", loaded: 10, total: 100, progress: 10 },
      at: "2026-08-07T07:00:00.001Z",
      nowMs: 1,
    });

    expect(total).toMatchObject({
      kind: "model-load",
      candidateId: "webgpu-q4f16",
      aggregateLoaded: 10,
      eventCount: 1,
      progressTotalEventCount: 1,
    });
    expect(file).toMatchObject({
      currentFile: "model.onnx",
      fileLoaded: 10,
      eventCount: 2,
      progressEventCount: 1,
      progressTotalEventCount: 1,
    });
  });

  it("suppresses high-frequency equivalent progress while preserving repeat counts in the next sample", () => {
    const tracker = createModelLoadProgressTracker({ candidateId: "webgpu-q4f16" });
    tracker.observe({
      info: { status: "progress", file: "model.onnx", loaded: 10, total: 100, progress: 10 },
      at: "2026-08-07T07:00:00.000Z",
      nowMs: 0,
    });

    expect(tracker.observe({
      info: { status: "progress", file: "model.onnx", loaded: 10, total: 100, progress: 10 },
      at: "2026-08-07T07:00:00.100Z",
      nowMs: 100,
    })).toBeUndefined();

    const sampled = tracker.observe({
      info: { status: "progress", file: "model.onnx", loaded: 10, total: 100, progress: 10 },
      at: "2026-08-07T07:00:01.100Z",
      nowMs: 1100,
    });
    expect(sampled).toMatchObject({
      eventCount: 3,
      forwardProgressCount: 1,
      repeatedWithoutForwardProgressCount: 2,
      lastForwardProgressAt: "2026-08-07T07:00:00.000Z",
    });
  });

  it("records forward progress and resets the repeated-event counter", () => {
    const tracker = createModelLoadProgressTracker({ candidateId: "webgpu-q4" });
    tracker.observe({
      info: { status: "progress", file: "model.onnx", loaded: 10, total: 100 },
      at: "2026-08-07T07:00:00.000Z",
      nowMs: 0,
    });
    tracker.observe({
      info: { status: "progress", file: "model.onnx", loaded: 10, total: 100 },
      at: "2026-08-07T07:00:00.100Z",
      nowMs: 100,
    });
    const forwarded = tracker.observe({
      info: { status: "progress", file: "model.onnx", loaded: 20, total: 100 },
      at: "2026-08-07T07:00:01.100Z",
      nowMs: 1100,
    });

    expect(forwarded).toMatchObject({
      fileLoaded: 20,
      forwardProgressCount: 2,
      repeatedWithoutForwardProgressCount: 0,
      lastForwardProgressAt: "2026-08-07T07:00:01.100Z",
    });
  });
});
