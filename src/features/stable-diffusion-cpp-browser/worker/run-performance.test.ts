import { expect, it, vi } from 'vitest';
import { createRunPerformance } from './run-performance';
import { requestFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import { createImageTrace, createImageDiagnosticBuffer, imageDiagnosticSchema } from '@/features/stable-diffusion-cpp-browser/diagnostics';
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

const placementFields = {
  nodes: 3,
  cpu: 1,
  webgpu: 2,
  other: 0,
  bf16: 1,
  inspected: 1,
  cpu_bf16: 1,
  webgpu_bf16: 0,
  other_bf16: 0,
  cpu_unsupported_bf16: 1,
  webgpu_weights: 1,
  host_weights: 0,
  other_weights: 0,
  webgpu_cpu_bf16: 1,
  webgpu_cpu_bf16_use_bytes: 2048,
};
function placementLog({ fields }: { fields: Partial<typeof placementFields> }): string {
  return 'compute_workspace.cpp:91 - browser-placement-v1 ' + Object.entries({ ...placementFields, ...fields }).map(([name, value]) => `${name}=${value}`).join(' ') + '\n';
}

it('reports allocated BF16 CPU boundaries separately from measured GPU transfers, including operand bytes over 4 GiB', () => {
  const emit = vi.fn(), request = requestFixture();
  const meter = createRunPerformance({ enabled: true, request, emit, checkpoint: vi.fn(), now: () => 0 });
  meter.native({ signal: { kind: 'conditioning' } });
  meter.log({ message: placementLog({ fields: { webgpu_cpu_bf16_use_bytes: 5 * 1024 ** 3 } }) });
  meter.native({ signal: { kind: 'sampling-progress', step: 0, steps: request.parameters.steps } });
  meter.log({ message: placementLog({ fields: {} }) });
  meter.log({ message: placementLog({ fields: {} }) });
  meter.native({ signal: { kind: 'sampling-progress', step: 1, steps: request.parameters.steps } });
  meter.finish({ outcome: 'complete' });
  const windows = emit.mock.calls.filter(([entry]) => entry.fields.metric === 'graph-placement-window');
  expect(windows.map(([entry]) => entry.fields)).toMatchObject([
    { phase: 'conditioning', allocationReports: 1, scheduledWebgpuToCpuBf16WeightUseBytes: 5 * 1024 ** 3 },
    { phase: 'sampling', step: 0, allocationReports: 2, cpuBf16WeightMatmuls: 2, scheduledWebgpuToCpuBf16WeightUseBytes: 4096 },
  ]);
  const summary = emit.mock.calls.find(([entry]) => entry.fields.metric === 'graph-placement-summary')![0].fields;
  expect(summary).toMatchObject({
    allocationReports: 3,
    assignedNodes: 9,
    cpuNodes: 3,
    webgpuNodes: 6,
    bf16WeightMatmuls: 3,
    inspectedBf16WeightMatmuls: 3,
    cpuBf16WebgpuUnsupported: 3,
    webgpuBf16WeightUses: 3,
    scheduledWebgpuToCpuBf16WeightUses: 3,
    scheduledWebgpuToCpuBf16WeightUseBytes: 5 * 1024 ** 3 + 4096,
    observation: 'allocation-metadata',
    weightBytesMeaning: 'operand-uses-not-unique-residency',
    actualTransfersMeasured: false,
    coverage: 'observed-allocations',
  });
  for (const [entry] of emit.mock.calls) expect(imageDiagnosticSchema.safeParse({ ...entry, elapsedMs: 0 }).success).toBe(true);
});

it('marks bounded and malformed placement reports as partial without exporting arbitrary text', () => {
  const emit = vi.fn();
  const meter = createRunPerformance({ enabled: true, request: requestFixture(), emit, checkpoint: vi.fn(), now: () => 0 });
  meter.log({ message: placementLog({ fields: { bf16: 3 } }) });
  meter.log({ message: placementLog({ fields: { nodes: 2 } }) });
  meter.log({ message: placementLog({ fields: { webgpu_cpu_bf16_use_bytes: Number.MAX_SAFE_INTEGER + 1 } }) });
  meter.log({ message: placementLog({ fields: {} }).trim() + ' tensor=private-model-name' });
  meter.finish({ outcome: 'failed' });
  const summary = emit.mock.calls.find(([entry]) => entry.fields.metric === 'graph-placement-summary')![0].fields;
  expect(summary).toMatchObject({ allocationReports: 1, invalidReports: 3, bf16WeightMatmuls: 3, inspectedBf16WeightMatmuls: 1, uninspectedBf16WeightMatmuls: 2, coverage: 'partial' });
  expect(JSON.stringify(emit.mock.calls)).not.toContain('private-model-name');
});

it('reports unobserved placement for older cores or retained runs without allocations, without carrying previous counts', () => {
  const first = vi.fn(), second = vi.fn();
  const initial = createRunPerformance({ enabled: true, request: requestFixture(), emit: first, checkpoint: vi.fn(), now: () => 0 });
  initial.log({ message: placementLog({ fields: {} }) });
  initial.finish({ outcome: 'complete' });
  const retained = createRunPerformance({ enabled: true, request: requestFixture(), emit: second, checkpoint: vi.fn(), now: () => 0 });
  retained.settings();
  retained.finish({ outcome: 'cancelled' });
  expect(first.mock.calls.find(([entry]) => entry.fields.metric === 'graph-placement-summary')![0].fields.coverage).toBe('observed-allocations');
  expect(second.mock.calls.find(([entry]) => entry.fields.metric === 'graph-placement-summary')![0].fields).toMatchObject({ allocationReports: 0, bf16WeightMatmuls: 0, coverage: 'not-observed' });
  expect(second.mock.calls.find(([entry]) => entry.fields.metric === 'run-settings')![0].fields.semanticBackendTrace).toBe(false);
});

it('preserves structured placement summaries when raw native logs hit the rate limit', () => {
  const buffer = createImageDiagnosticBuffer();
  const trace = createImageTrace({ debug: 'on', secrets: [], listener: buffer.append, now: () => 0 });
  const meter = createRunPerformance({ enabled: true, request: requestFixture(), emit: trace.emit, checkpoint: vi.fn(), now: () => 0 });
  for (let index = 0; index < 100; index++) trace.native({ message: 'ordinary native log', level: 1 });
  const message = placementLog({ fields: {} });
  // The Worker observes structured measurements before its raw-log limiter.
  meter.log({ message });
  trace.native({ message, level: 1 });
  const conversion = 'model_manager.cpp:310 - browser-weight-conversion-v1 target=f32 tensors=2 source_bytes=2064 destination_bytes=4128 extra_bytes=2064\n';
  meter.log({ message: conversion });
  trace.native({ message: conversion, level: 1 });
  meter.finish({ outcome: 'complete' });
  const text = buffer.text();
  expect(text).not.toContain('browser-placement-v1');
  expect(text).toContain('"metric":"graph-placement-summary"');
  expect(text).toContain('"cpuBf16WebgpuUnsupported":1');
  expect(text).not.toContain('browser-weight-conversion-v1');
  expect(text).toContain('"metric":"weight-conversion"');
  expect(text).toContain('"extraBytes":2064');
});

it.each(['f32', 'f16'])('records unique BF16 conversion bytes for %s without graph-use or peak-memory claims', target => {
  const emit = vi.fn(), sourceBytes = 5 * 1024 ** 3, destinationBytes = sourceBytes * (target === 'f32' ? 2 : 1), extraBytes = destinationBytes - sourceBytes;
  const meter = createRunPerformance({ enabled: true, request: requestFixture(), emit, checkpoint: vi.fn() });
  const message = `model_manager.cpp:310 - browser-weight-conversion-v1 target=${target} tensors=8 source_bytes=${sourceBytes} destination_bytes=${destinationBytes} extra_bytes=${extraBytes}\n`;
  meter.log({ message });
  expect(emit).toHaveBeenCalledOnce();
  expect(emit.mock.calls[0]![0].fields).toMatchObject({ metric: 'weight-conversion', target, tensors: 8, sourceBytes, destinationBytes, extraBytes, weightBytesMeaning: 'unique-parameter-payload-not-allocation-or-peak' });
  expect(imageDiagnosticSchema.safeParse({ ...emit.mock.calls[0]![0], elapsedMs: 0 }).success).toBe(true);
  emit.mockClear();
  for (const invalid of [message.replace(`extra_bytes=${extraBytes}`, 'extra_bytes=1'), message.replace('tensors=8', 'tensors=9007199254740992'), message.trim() + ' tensor=private']) meter.log({ message: invalid });
  expect(emit).not.toHaveBeenCalled();
});
