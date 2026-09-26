import { expect, it, vi } from 'vitest';
import { createRunPerformance } from './run-performance';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { imageDiagnosticSchema } from '@/features/stable-diffusion-cpp-browser/diagnostics';
it('uses only native sampling zero as the step start and records rounded preview time separately', () => {
  let time = 0; const emit = vi.fn(), checkpoint = vi.fn();
  const request = requestFixture(); request.parameters.steps = 8;
  const meter = createRunPerformance({ enabled: true, request, emit, checkpoint, now: () => time });
  time = 10; meter.phase({ next: 'model-load' }); time = 50; meter.phase({ next: 'prepare' });
  time = 60; meter.native({ signal: { kind: 'conditioning' } });
  time = 90; meter.native({ signal: { kind: 'sampling-progress', step: 0, steps: 8 } });
  time = 100; meter.native({ signal: { kind: 'sampling-progress', step: 0, steps: 8 } });
  meter.log({ message: 'vae.hpp:319 - computing vae decode graph completed, taking 0.02s\n' });
  time = 150; meter.native({ signal: { kind: 'sampling-progress', step: 1, steps: 8 } });
  meter.native({ signal: { kind: 'sampling-progress', step: 1, steps: 8 } });
  time = 160; meter.phase({ next: 'decoding' });
  meter.log({ message: 'vae.hpp:319 - computing vae decode graph completed, taking 0.01s\n' });
  time = 180; meter.phase({ next: 'encoding' }); time = 190; meter.finish({ outcome: 'complete' });
  const steps = emit.mock.calls.filter(([e]) => e.fields.metric === 'step-wall'); expect(steps).toHaveLength(1);
  expect(steps[0]?.[0].fields).toMatchObject({ milliseconds: 60, previewReportedMs: 20 });
  const summary = emit.mock.calls.at(-1)![0].fields;
  expect(summary).toMatchObject({ metric: 'run-wall', milliseconds: 190, conditioning: 30, sampling: 70, decoding: 20, encoding: 10, nativePreviewDecodeMs: 20, nativeFinalDecodeMs: 10 });
  for (const [entry] of emit.mock.calls) expect(imageDiagnosticSchema.safeParse({ ...entry, elapsedMs: 0 }).success).toBe(true);
});
it('does not leak prompt, model arguments, native labels or raw user-agent suffixes', () => {
  const emit = vi.fn(), request = requestFixture(); request.parameters.prompt = 'private text'; request.parameters.modelArguments = 'key=private';
  const meter = createRunPerformance({ enabled: true, request, emit, checkpoint: vi.fn(), now: () => 0 }); meter.settings();
  meter.log({ message: 'user private text https://private/' });
  meter.log({ message: 'ggml_runner.cpp:970 - user_secret executing segment 1/1: graph' });
  meter.finish({ outcome: 'failed' });
  const text = JSON.stringify(emit.mock.calls); expect(text).not.toContain('private'); expect(text).not.toContain('user_secret');
  expect(emit.mock.calls.at(-1)![0].fields.otherGraphStarts).toBe(1);
});
it('has no timing/parsing/logging work while disabled and emits no late measurements after close', () => {
  const now = vi.fn(() => 0), emit = vi.fn(), checkpoint = vi.fn();
  const disabled = createRunPerformance({ enabled: false, request: requestFixture(), now, emit, checkpoint });
  disabled.settings(); disabled.phase({ next: 'sampling' }); disabled.native({ signal: { kind: 'conditioning' } }); disabled.log({ message: 'x' }); disabled.finish({ outcome: 'failed' });
  expect(now).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled(); expect(checkpoint).not.toHaveBeenCalled();
  const enabled = createRunPerformance({ enabled: true, request: requestFixture(), now, emit, checkpoint }); enabled.finish({ outcome: 'cancelled' });
  emit.mockClear(); enabled.preview({ fields: { late: true } }); enabled.finish({ outcome: 'complete' }); expect(emit).not.toHaveBeenCalled();
});

it('distinguishes absent native summaries from measured zero and retains partial cancelled-step time', () => {
  const request = requestFixture(), emit = vi.fn(); let time = 0;
  const meter = createRunPerformance({ enabled: true, request, emit, checkpoint: vi.fn(), now: () => time });
  time = 3; meter.native({ signal: { kind: 'sampling-progress', step: 0, steps: request.parameters.steps } });
  time = 10; meter.finish({ outcome: 'cancelled' });
  const fields = emit.mock.calls.at(-1)![0].fields;
  expect(fields).toMatchObject({ partialStepWallMs: 7, completedStepIntervals: 0, nativeConditionReports: 0, nativeSamplingReports: 0, nativeFinalDecodeReports: 0 });
  expect(imageDiagnosticSchema.safeParse({ ...emit.mock.calls.at(-1)![0], elapsedMs: 10 }).success).toBe(true);
});
