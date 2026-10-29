import { describe, expect, it } from 'vitest';
import { q8KernelBenchmarkSchema, q8KernelBenchmarkProgressSchema } from './q8-kernel-schema';
import { createQ8BenchmarkWireFixture, createQ8PairedBenchmarkWireFixture } from './q8-kernel-schema.test-support';

describe('bounded Q8 benchmark wire contract', () => {
  it('accepts the exact eight-shape, six-variant, 192-sample schedule after JSON serialization', () => {
    const value = createQ8BenchmarkWireFixture();
    expect(q8KernelBenchmarkSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });

  it.each(['variant-duplicate', 'shape-order', 'sample-order', 'tuple-change', 'hash-change', 'output-hash', 'input-hash', 'quantized', 'timing-status', 'sample-count', 'status', 'bytes', 'extra'] as const)('rejects inconsistent %s evidence', failure => {
    const value = createQ8BenchmarkWireFixture(), shape = value.shapes[0]!, sample = shape.samples[0]!;
    if (failure === 'variant-duplicate') {
 shape.variants[1]!.variant = 'auto';
    }
    if (failure === 'shape-order') {
      value.shapes.reverse();
    }
    if (failure === 'sample-order') {
      sample.round = 1;
    }
    if (failure === 'tuple-change') {
      sample.report.workgroupSize = 256;
    }
    if (failure === 'hash-change') {
      sample.report.shaderSha256 = 'f'.repeat(64);
    }
    if (failure === 'output-hash') {
 shape.variants[0]!.warmup!.exact!.actualSha256 = 'f'.repeat(64);
    }
    if (failure === 'input-hash') {
 shape.inputsUnchanged!.weightSha256 = 'f'.repeat(64);
    }
    if (failure === 'quantized') {
      sample.timingStatus = 'quantized';
    }
    if (failure === 'timing-status') {
      sample.timingStatus = 'partial';
      sample.gpuMsPerDispatch = undefined;
    }
    if (failure === 'sample-count') {
      shape.samples.pop();
    }
    if (failure === 'status') {
      value.status = 'partial';
    }
    if (failure === 'bytes') {
      shape.fixture.weightBytes++;
    }
    if (failure === 'extra') {
      Reflect.set(value, 'winner', 'auto');
    }
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
  });

  it('allows a cancelled prefix but rejects extra shapes, samples and malformed digest identifiers', () => {
    const value = createQ8BenchmarkWireFixture();
    value.status = 'cancelled';
    value.shapes = value.shapes.slice(0, 1);
value.shapes[0]!.samples = value.shapes[0]!.samples.slice(0, 7);
expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(true);
    value.shapes[0]!.samples[0]!.report.shaderSha256 = 'not-a-hash';
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
    const tooMany = createQ8BenchmarkWireFixture();
    tooMany.shapes.push(tooMany.shapes[0]!);
    expect(q8KernelBenchmarkSchema.safeParse(tooMany).success).toBe(false);
    const samples = createQ8BenchmarkWireFixture();
samples.shapes[0]!.samples.push(samples.shapes[0]!.samples[0]!);
expect(q8KernelBenchmarkSchema.safeParse(samples).success).toBe(false);
  });

  it('bounds progress independently of variant support', () => {
    expect(q8KernelBenchmarkProgressSchema.parse({ shapeIndex: 7, shapeCount: 8, phase: 'verifying', completedSamples: 128, totalSamples: 192 }).completedSamples).toBe(128);
    expect(q8KernelBenchmarkProgressSchema.safeParse({ shapeIndex: 8, shapeCount: 8, phase: 'verifying', completedSamples: 192, totalSamples: 192 }).success).toBe(false);
    const progress = { shapeIndex: 7, shapeCount: 8, phase: 'measuring', section: 'paired', completedSamples: 192, totalSamples: 256, baseCompletedSamples: 168, pairedCompletedSamples: 24 };
    expect(q8KernelBenchmarkProgressSchema.parse(progress)).toEqual(progress);
    expect(q8KernelBenchmarkProgressSchema.safeParse({ ...progress, pairedCompletedSamples: 25 }).success).toBe(false);
    expect(q8KernelBenchmarkProgressSchema.safeParse({ ...progress, pairedCompletedSamples: 65, completedSamples: 233 }).success).toBe(false);
  });

  it.each([false, true])('round-trips the optional 64 paired samples without requiring distinct A/B shaders (same: %s)', sameShader => {
    const value = createQ8PairedBenchmarkWireFixture({ sameShader });
    expect(q8KernelBenchmarkSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(value.shapes.reduce((sum, shape) => sum + shape.samples.length, 0)).toBe(192);
    expect(value.shapes.reduce((sum, shape) => sum + (shape.pairedComparison?.samples.length ?? 0), 0)).toBe(64);
  });

  it.each(['missing', 'wrong-shape', 'missing-protocol', 'order', 'arm', 'position', 'sequence', 'count', 'identity', 'exact', 'clock', 'clock-origin', 'wall', 'timestamp', 'warmup', 'unsupported', 'status'] as const)('rejects inconsistent paired %s evidence', failure => {
    const value = createQ8PairedBenchmarkWireFixture({ sameShader: false }), shape = value.shapes[6]!, paired = shape.pairedComparison!, sample = paired.samples[1]!;
    if (failure === 'missing') {
      shape.pairedComparison = undefined;
    }
    if (failure === 'wrong-shape') {
 value.shapes[0]!.pairedComparison = paired;
    }
    if (failure === 'missing-protocol') {
      value.pairedComparisonProtocol = undefined;
    }
    if (failure === 'order') {
      sample.order = 'BAAB';
    }
    if (failure === 'arm') {
      sample.arm = 'A';
    }
    if (failure === 'position') {
      sample.position = 2;
    }
    if (failure === 'sequence') {
      sample.sequence = 0;
    }
    if (failure === 'count') {
      paired.samples.pop();
    }
    if (failure === 'identity') {
      sample.report.shaderSha256 = 'f'.repeat(64);
    }
    if (failure === 'exact') {
      sample.exact.actualSha256 = 'f'.repeat(64);
    }
    if (failure === 'clock') {
      sample.callEndedMs = sample.callStartedMs - 1;
    }
    if (failure === 'clock-origin') {
 value.shapes[7]!.pairedComparison!.samples[0]!.callStartedMs = 0;
    }
    if (failure === 'wall') {
      sample.wallMs++;
    }
    if (failure === 'timestamp') {
      sample.gpuProfile.observedPasses = 31;
    }
    if (failure === 'warmup') {
      paired.warmups.reverse();
    }
    if (failure === 'unsupported') {
      paired.status = 'unsupported';
    }
    if (failure === 'status') {
      paired.status = 'cancelled';
    }
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
  });

  it('accepts an actual cancelled paired prefix but rejects gaps or samples without its two verified warmups', () => {
    const value = createQ8PairedBenchmarkWireFixture({ sameShader: false });
    value.status = 'cancelled';
    value.shapes = value.shapes.slice(0, 7);
    const paired = value.shapes[6]!.pairedComparison!;
    paired.status = 'cancelled';
    paired.samples = paired.samples.slice(0, 5);
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(true);
    paired.samples.splice(2, 1);
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
    paired.samples = [];
    paired.warmups = paired.warmups.slice(0, 1);
    paired.warmups[0]!.exact = undefined;
    paired.warmups[0]!.readbackMs = undefined;
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(true);
    paired.samples = [createQ8PairedBenchmarkWireFixture({ sameShader: false }).shapes[6]!.pairedComparison!.samples[0]!];
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
  });

  it.each(['cancelled-pair', 'missing-pair', 'unverified-inputs'] as const)('rejects later shapes after an earlier %s in the new protocol', failure => {
    const value = createQ8PairedBenchmarkWireFixture({ sameShader: false }), shape = value.shapes[6]!;
    value.status = 'cancelled';
    if (failure === 'cancelled-pair') {
      shape.pairedComparison!.status = 'cancelled';
      shape.pairedComparison!.samples = shape.pairedComparison!.samples.slice(0, 5);
    }
    if (failure === 'missing-pair') {
      shape.pairedComparison = undefined;
    }
    if (failure === 'unverified-inputs') {
      shape.inputsUnchanged = undefined;
    }
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
  });

  it.each(['missing-readback', 'incomplete-earlier-warmup'] as const)('rejects a paired sample prefix after %s', failure => {
    const value = createQ8PairedBenchmarkWireFixture({ sameShader: false });
    value.status = 'cancelled';
    value.shapes = value.shapes.slice(0, 7);
    const paired = value.shapes[6]!.pairedComparison!;
    paired.status = 'cancelled';
    paired.samples = paired.samples.slice(0, 5);
    paired.warmups[1]!.readbackMs = undefined;
    if (failure === 'incomplete-earlier-warmup') {
      paired.samples = [];
      paired.warmups[0]!.exact = undefined;
      paired.warmups[0]!.readbackMs = undefined;
    }
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
  });

  it('preserves an explicitly unsupported pair with its native unsupported warmup and no one-sided samples', () => {
    const value = createQ8PairedBenchmarkWireFixture({ sameShader: false });
    value.status = 'partial';
    const paired = value.shapes[6]!.pairedComparison!, warmup = paired.warmups[1]!;
    paired.status = 'unsupported';
    paired.samples = [];
    warmup.call.report = {
      ...warmup.call.report,
      status: 'unsupported',
      algorithm: 'none',
      workgroupSize: 0,
      logicalSubgroupSize: 0,
      realMinSubgroupSize: 0,
      realMaxSubgroupSize: 0,
      rowsPerTile: 0,
      outputsPerWorkgroup: 0,
      cooperativeSubgroupReduction: false,
      grid: { x: 0, y: 0, z: 0 },
      dispatches: 0,
      codegenRevision: 0,
      shaderSha256: undefined,
    };
    warmup.exact = undefined;
    warmup.readbackMs = undefined;
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(true);
    const continuedAfterUnsupported = structuredClone(value), continued = continuedAfterUnsupported.shapes[6]!.pairedComparison!;
    const successful = structuredClone(continued.warmups[0]!);
    continued.warmups[0] = {
      ...continued.warmups[1]!,
      variant: 'auto',
      call: {
        ...continued.warmups[1]!.call,
        report: { ...continued.warmups[1]!.call.report, variant: 'auto' },
      },
    };
    const preparedB = continuedAfterUnsupported.shapes[6]!.variants[2]!.prepare.report;
    continued.warmups[1] = {
      ...successful,
      variant: 'independent-wg128-r4',
      call: {
        ...successful.call,
        report: { ...preparedB, phase: 'execute', dispatches: 1 },
      },
    };
    expect(q8KernelBenchmarkSchema.safeParse(continuedAfterUnsupported).success).toBe(false);
    warmup.exact = paired.warmups[0]!.exact;
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
  });

  it.each(['observed', 'measured', 'pending', 'invalid', 'dropped', 'ungrouped', 'ambiguous', 'instrumentation', 'zero-count', 'row-passes', 'row-dispatches', 'multi-dispatch', 'readback-pending', 'readback-rejected', 'readback-invalid'] as const)('rejects qualified timestamp counter contradiction %s', failure => {
    const value = createQ8BenchmarkWireFixture(), profile = value.shapes[0]!.samples[0]!.gpuProfile;
    if (failure === 'observed') {
      profile.observedPasses = 31;
    }
    if (failure === 'measured') {
      profile.measuredPasses = 31;
    }
    if (failure === 'pending') {
      profile.pendingPasses = 1;
    }
    if (failure === 'invalid') {
      profile.invalidPasses = 1;
    }
    if (failure === 'dropped') {
      profile.droppedPasses = 1;
    }
    if (failure === 'ungrouped') {
      profile.ungroupedPasses = 1;
    }
    if (failure === 'ambiguous') {
      profile.ambiguousPasses = 1;
    }
    if (failure === 'instrumentation') {
      profile.instrumentationErrors = 1;
    }
    if (failure === 'zero-count') {
      profile.zeroDurationPasses = 1;
    }
    if (failure === 'row-passes') {
 profile.rows[0]!.passes = 31;
    }
    if (failure === 'row-dispatches') {
 profile.rows[0]!.dispatches = 31;
    }
    if (failure === 'multi-dispatch') {
 profile.rows[0]!.multiDispatchPasses = 1;
    }
    if (failure.startsWith('readback-')) {
      profile.readbacks = {
        source: 'existing-timestamp-buffer-mapAsync',
        phaseAt: 'map-request',
        rows: [{
          phase: 'other',
          requested: 1,
          completed: 0,
          pending: Number(failure === 'readback-pending'),
          rejected: Number(failure === 'readback-rejected'),
          invalidTimings: Number(failure === 'readback-invalid'),
          totalWaitMs: 0,
          maximumWaitMs: 0,
        }],
      };
    }
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
  });

  it.each(['rows', 'passes', 'dispatches'] as const)('bounds incomplete sample %s evidence to 32', failure => {
    const value = createQ8BenchmarkWireFixture(), sample = value.shapes[0]!.samples[0]!;
    sample.timingStatus = 'partial';
    sample.gpuMsPerDispatch = undefined;
    if (failure === 'rows') {
      sample.gpuProfile.rows = Array.from({ length: 33 }, () => ({ ...sample.gpuProfile.rows[0]!, passes: 1, dispatches: 1 }));
    }
    if (failure === 'passes') {
 sample.gpuProfile.rows[0]!.passes = 33;
    }
    if (failure === 'dispatches') {
 sample.gpuProfile.rows[0]!.dispatches = 33;
    }
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
  });

  it('requires measured exact output evidence and rejects successful evidence attached to an unsupported warmup', () => {
    const value = createQ8BenchmarkWireFixture();
    value.shapes[0]!.samples[0]!.exact.actualSha256 = 'f'.repeat(64);
    expect(q8KernelBenchmarkSchema.safeParse(value).success).toBe(false);
    const unsupported = createQ8BenchmarkWireFixture(), warmup = unsupported.shapes[0]!.variants[0]!.warmup!;
    warmup.call.report = {
      ...warmup.call.report,
      status: 'unsupported',
      algorithm: 'none',
      workgroupSize: 0,
      logicalSubgroupSize: 0,
      realMinSubgroupSize: 0,
      realMaxSubgroupSize: 0,
      rowsPerTile: 0,
      outputsPerWorkgroup: 0,
      cooperativeSubgroupReduction: false,
      grid: { x: 0, y: 0, z: 0 },
      dispatches: 0,
      codegenRevision: 0,
      shaderSha256: undefined,
    };
    unsupported.status = 'partial';
    expect(q8KernelBenchmarkSchema.safeParse(unsupported).success).toBe(false);
  });
});
