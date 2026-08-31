import { describe, expect, it } from "vitest";
import { createModelLoadProgressTracker, TEST_ONLY } from "@/features/transformers-js/model-support-investigation/logic/model-load-progress";

describe("createModelLoadProgressTracker", () => {
  it("collapses the Transformers.js progress_total/progress pair into one time-bounded diagnostic sample", () => {
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
      artifactSource: "downloaded-model-cache",
      artifactSourceBasis: "load-policy",
      progressByteSemantics: "response-body-read-not-network-proof",
      candidateId: "webgpu-q4f16",
      aggregateLoaded: 10,
      eventCount: 1,
      progressTotalEventCount: 1,
      publishedSampleCount: 1,
      firstActivityAt: "2026-08-07T07:00:00.000Z",
    });
    expect(file).toBeUndefined();

    const sampled = tracker.observe({
      info: { status: "progress", file: "model.onnx", loaded: 20, total: 100, progress: 20 },
      at: "2026-08-07T07:00:01.001Z",
      nowMs: TEST_ONLY.MINIMUM_PUBLISH_INTERVAL_MS + 1,
    });
    expect(sampled).toMatchObject({
      currentFile: "model.onnx",
      fileLoaded: 20,
      eventCount: 3,
      progressEventCount: 2,
      progressTotalEventCount: 1,
      publishedSampleCount: 2,
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
      publishedSampleCount: 2,
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

  it("does not let alternating GPT-OSS split files bypass the publish interval", () => {
    const tracker = createModelLoadProgressTracker({ candidateId: "webgpu-q4f16" });
    const files = Array.from({ length: 6 }, (_, index) => `onnx/model_q4f16.onnx_data_${index}`);
    const published = [];

    for (let index = 0; index < 100_000; index += 1) {
      const sample = tracker.observe({
        info: {
          status: "progress",
          file: files[index % files.length],
          loaded: index,
          total: 100_000,
          progress: index / 1000,
        },
        at: new Date(index).toISOString(),
        nowMs: index / 10,
      });
      if (sample !== undefined) published.push(sample);
    }

    // Ten seconds of 100k raw callbacks may produce roughly one sample per
    // second, never one sample per file switch.
    expect(published.length).toBeLessThanOrEqual(11);
    expect(published.at(-1)).toMatchObject({
      eventCount: expect.any(Number),
      publishedSampleCount: published.length,
      artifactSource: "downloaded-model-cache",
    });
    expect(published.at(-1)!.eventCount).toBeGreaterThan(90_000);

    const final = tracker.flush();
    expect(final).toMatchObject({
      eventCount: 100_000,
      progressEventCount: 100_000,
      publishedSampleCount: published.length + 1,
    });
    expect(tracker.flush()).toBeUndefined();
  });

  it("keeps one million adversarial split-file callbacks bounded without losing the final raw count", () => {
    const tracker = createModelLoadProgressTracker({ candidateId: "webgpu-q4f16" });
    const files = Array.from({ length: 6 }, (_, index) => `onnx/model_q4f16.onnx_data_${index}`);
    let publishedCount = 0;

    for (let index = 0; index < 1_000_000; index += 1) {
      const sample = tracker.observe({
        info: {
          status: "progress",
          file: files[index % files.length],
          loaded: index + 1,
          total: 1_000_000,
          progress: ((index + 1) / 1_000_000) * 100,
        },
        at: "2026-08-07T07:00:00.000Z",
        nowMs: index / 1000,
      });
      if (sample !== undefined) publishedCount += 1;
    }

    // One million callbacks compressed into less than one second of synthetic
    // wall time must not turn into one million Worker/main-thread messages.
    expect(publishedCount).toBe(1);
    expect(tracker.flush()).toMatchObject({
      eventCount: 1_000_000,
      progressEventCount: 1_000_000,
      publishedSampleCount: 2,
      artifactSource: "downloaded-model-cache",
    });
  });

  it("does not let large byte or percentage jumps bypass the publish interval", () => {
    const tracker = createModelLoadProgressTracker({ candidateId: "webgpu-q4f16" });
    tracker.observe({
      info: { status: "progress_total", loaded: 1, total: 10_000_000_000, progress: 0 },
      at: "2026-08-07T07:00:00.000Z",
      nowMs: 0,
    });

    for (let index = 1; index <= 100; index += 1) {
      expect(tracker.observe({
        info: {
          status: "progress_total",
          loaded: index * 100_000_000,
          total: 10_000_000_000,
          progress: index,
        },
        at: `2026-08-07T07:00:00.${String(index).padStart(3, "0")}Z`,
        nowMs: index,
      })).toBeUndefined();
    }
  });

  it("records actual OPFS cache hits, misses, bytes, and blocked remote fetch attempts even without raw progress callbacks", () => {
    const tracker = createModelLoadProgressTracker({ candidateId: "webgpu-q4" });

    tracker.observeCacheMatch({
      observation: { requestedPath: "huggingface.co/org/repo/resolve/main/model.onnx", result: "hit", bytes: 128 },
      at: "2026-08-07T07:00:00.000Z",
    });
    tracker.observeCacheMatch({
      observation: { requestedPath: "huggingface.co/org/repo/resolve/main/missing.onnx", result: "miss", bytes: undefined },
      at: "2026-08-07T07:00:00.001Z",
    });
    tracker.observeRemoteFetchAttempt({ at: "2026-08-07T07:00:00.002Z" });

    expect(tracker.flush()).toMatchObject({
      eventCount: 0,
      cacheMatchRequestCount: 2,
      cacheHitCount: 1,
      cacheMissCount: 1,
      cacheAliasHitCount: 0,
      cacheMatchedBytes: 128,
      remoteFetchAttemptCount: 1,
      sourceStatus: "remote-fetch-attempt",
      publishedSampleCount: 1,
    });
    expect(tracker.flush()).toBeUndefined();
  });

  it("publishes lifecycle events immediately even inside the progress interval", () => {
    const tracker = createModelLoadProgressTracker({ candidateId: "webgpu-q4f16" });
    tracker.observe({
      info: { status: "progress", file: "model.onnx", loaded: 1, total: 100 },
      at: "2026-08-07T07:00:00.000Z",
      nowMs: 0,
    });

    const done = tracker.observe({
      info: { status: "done", file: "model.onnx" },
      at: "2026-08-07T07:00:00.001Z",
      nowMs: 1,
    });
    expect(done).toMatchObject({
      sourceStatus: "done",
      eventCount: 2,
      publishedSampleCount: 2,
    });
  });
});
