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
  it('preserves completed Download probes when a later Provider operation stops', () => {
    const now = () => '2026-09-10T00:00:00.000Z';
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'post-probe-stop', now });
    checkpoint.run.steps = checkpoint.run.steps.map(step => step.id === 'download-evidence'
      ? { ...step, status: 'passed', detail: 'Bounded probes completed' }
      : step.id === 'loading-investigation' ? { ...step, status: 'running', detail: 'Provider pending' } : step);
    const result = interruptInvestigationCheckpoint({ checkpoint, error: new Error('Owned Provider deadline'), now });
    expect(result.run.steps.find(step => step.id === 'download-evidence')).toMatchObject({ status: 'passed', detail: 'Bounded probes completed' });
    expect(result.run.steps.find(step => step.id === 'loading-investigation')).toMatchObject({ status: 'failed', detail: 'Interrupted: Owned Provider deadline' });
    expect(result.recovery.interruption?.error.message).toBe('Owned Provider deadline');
  });

  it('refuses a completed checkpoint with an unclosed owner and preserves already settled evidence', () => {
    const now = () => '2026-09-10T00:00:00.000Z';
    const initial = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'terminal-owner', now });
    const run = structuredClone(initial.run);
    run.status = 'passed';
    run.error = 'Earlier measured failure';
    run.steps = run.steps.map(step => step.id === 'download-evidence'
      ? { ...step, status: 'running', detail: 'Probe owner was not closed' }
      : step.id === 'loading-investigation' ? { ...step, status: 'passed', detail: 'Existing Load completed' }
        : step.id === 'runtime-assets' ? { ...step, status: 'passed', detail: 'Runtime ready' } : step);
    const result = completeInvestigationCheckpoint({ checkpoint: initial, run, now });
    expect(result.recovery.status).toBe('interrupted');
    expect(result.recovery.interruption?.error).toMatchObject({ name: 'InvestigationTerminalInvariantError', message: 'Investigation completion retained running steps: download-evidence' });
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toContain('Earlier measured failure');
    expect(result.run.steps.find(step => step.id === 'download-evidence')).toMatchObject({ status: 'failed', detail: 'Interrupted: Investigation completion retained running steps: download-evidence' });
    expect(result.run.steps.find(step => step.id === 'loading-investigation')).toMatchObject({ status: 'passed', detail: 'Existing Load completed' });
    expect(run.steps.find(step => step.id === 'download-evidence')?.status).toBe('running');
  });

  it('preserves completed fresh preparation when a later investigation phase is interrupted', () => {
    const now = () => '2026-09-09T00:00:00.000Z';
    const checkpoint = createInitialInvestigationCheckpoint({ modelId: 'org/model', runId: 'later-interruption', now });
    checkpoint.run.freshMetadata = {
      schemaVersion: 1, modelId: 'org/model', revision: 'a'.repeat(40), source: 'fresh-network-memory',
      status: 'prepared', maximumBytes: 1024, receivedBytes: 0, requests: [],
      preparation: { processor: 'tokenizer', resourcePlansByCandidate: {} },
    };
    const stopped = interruptInvestigationCheckpoint({ checkpoint, error: new Error('Later phase stopped'), now });
    expect(stopped.recovery.status).toBe('interrupted');
    expect(stopped.run.freshMetadata).toEqual(checkpoint.run.freshMetadata);
    expect(checkpoint.run.freshMetadata.status).toBe('prepared');
  });

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
