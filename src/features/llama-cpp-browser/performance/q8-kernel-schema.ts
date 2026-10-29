import { z } from 'zod';
import { gpuProfileSchema, type GpuProfile } from './gpu-profile-schema';

export const q8KernelVariants = ['auto', 'cooperative-wg256-r4', 'independent-wg128-r4', 'independent-wg128-r1', 'independent-wg128-r2', 'cooperative-wg128-r2'] as const;
export const q8KernelShapes = [[2560, 10240], [2560, 6144], [6144, 2560], [10240, 320], [2560, 640], [2560, 512], [320, 10240], [640, 2560]] as const;
export const q8KernelPairedShapes = [[320, 10240], [640, 2560]] as const;
export const q8KernelPairedVariants = ['auto', 'independent-wg128-r4'] as const;

export function createQ8KernelPairedSchedule({ blocks }: { blocks: 8 }) {
  return Array.from({ length: blocks }, (_, block) => {
    const order = block % 2 ? 'BAAB' as const : 'ABBA' as const;
    return [...order].map((arm, position) => ({
      block,
      order,
      arm: arm as 'A' | 'B',
      position,
      sequence: block * 4 + position,
      variant: q8KernelPairedVariants[arm === 'A' ? 0 : 1],
    }));
  }).flat();
}

export const q8KernelVariantSchema = z.enum(q8KernelVariants);
const count = z.number().int().nonnegative().max(0xffffffff);
const milliseconds = z.number().finite().nonnegative();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const q8KernelNativeReportSchema = z.strictObject({
  status: z.enum(['ok', 'unavailable', 'bad-request', 'unsupported', 'not-prepared', 'busy']),
  variant: q8KernelVariantSchema,
  phase: z.enum(['prepare', 'execute']),
  algorithm: z.enum(['none', 'cooperative', 'independent']),
  workgroupSize: count,
  logicalSubgroupSize: count,
  realMinSubgroupSize: count,
  realMaxSubgroupSize: count,
  rowsPerTile: count,
  outputsPerWorkgroup: count,
  cooperativeSubgroupReduction: z.boolean(),
  grid: z.strictObject({ x: count, y: count, z: count }),
  dispatches: count,
  codegenRevision: count,
  shaderSha256: sha256.optional(),
  nativeWallMs: milliseconds,
}).superRefine((report, context) => {
  switch (report.status) {
  case 'ok':
    if (!report.shaderSha256 || report.shaderSha256 === '0'.repeat(64) || report.algorithm === 'none' || ![32, 64, 128, 256].includes(report.workgroupSize)
      || ![1, 2, 4].includes(report.rowsPerTile) || !report.outputsPerWorkgroup || !report.grid.x || !report.grid.y || report.grid.z !== 1
      || report.codegenRevision !== 1 || report.phase === 'prepare' && report.dispatches !== 0) {
      context.addIssue({ code: 'custom', message: 'Invalid successful Q8 native report' });
    }
    break;
  case 'unsupported':
    if (report.shaderSha256 !== undefined || report.algorithm !== 'none' || report.workgroupSize || report.logicalSubgroupSize || report.realMinSubgroupSize
      || report.realMaxSubgroupSize || report.rowsPerTile || report.outputsPerWorkgroup || report.cooperativeSubgroupReduction || report.grid.x || report.grid.y || report.grid.z
      || report.dispatches || report.codegenRevision) {
      context.addIssue({ code: 'custom', message: 'Invalid unsupported Q8 native report' });
    }
    break;
  case 'unavailable': case 'bad-request': case 'not-prepared': case 'busy':
    context.addIssue({ code: 'custom', message: 'Unexpected Q8 benchmark native status' });
    break;
  default: {
    const exhaustive: never = report.status;
    throw new Error(`Unhandled Q8 native status: ${exhaustive}`);
  }
  }
});

function reportIdentity({ report }: { report: z.infer<typeof q8KernelNativeReportSchema> }): string {
  const { status: _status, phase: _phase, dispatches: _dispatches, nativeWallMs: _nativeWallMs, ...tuple } = report;
  return JSON.stringify(tuple);
}

const callSchema = z.strictObject({ report: q8KernelNativeReportSchema, wallMs: milliseconds });
const exactSchema = z.strictObject({ words: count, mismatches: z.literal(0), expectedSha256: sha256, actualSha256: sha256, guards: z.literal(true) });
const warmupSchema = z.strictObject({ call: callSchema, readbackMs: milliseconds.optional(), exact: exactSchema.optional() });
const boundedProfileSchema = gpuProfileSchema.superRefine((profile, context) => {
  const passCounts = [profile.observedPasses, profile.measuredPasses, profile.pendingPasses, profile.invalidPasses, profile.droppedPasses, profile.ungroupedPasses, profile.ambiguousPasses, profile.zeroDurationPasses];
  const passes = profile.rows.reduce((sum, row) => sum + row.passes, 0), dispatches = profile.rows.reduce((sum, row) => sum + row.dispatches, 0);
  const incomplete = profile.pendingPasses + profile.invalidPasses + profile.droppedPasses + profile.ungroupedPasses + profile.ambiguousPasses + profile.instrumentationErrors > 0
    || (profile.readbacks?.rows.some(row => row.pending + row.rejected + row.invalidTimings > 0) ?? false);
  const expectedStatus = profile.measuredPasses === 0 ? 'unavailable' : incomplete ? 'partial' : 'complete';
  if (profile.status !== expectedStatus || profile.rows.length > 32 || passCounts.some(value => value > 32) || passes > 32 || dispatches > 32 || profile.measuredPasses > profile.observedPasses
    || passes > profile.measuredPasses || profile.zeroDurationPasses > profile.measuredPasses
    || profile.rows.reduce((sum, row) => sum + row.zeroDurationPasses, 0) > profile.zeroDurationPasses
    || profile.status === 'complete' && (passes !== profile.measuredPasses || profile.observedPasses !== profile.measuredPasses
      || profile.zeroDurationPasses !== profile.rows.reduce((sum, row) => sum + row.zeroDurationPasses, 0))
    || profile.rows.some(row => row.passes > 32 || row.dispatches > 32 || row.multiDispatchPasses > row.passes || row.zeroDurationPasses > row.passes)) {
    context.addIssue({ code: 'custom', message: 'Q8 sample timestamp coverage exceeds 32 dispatches' });
  }
});

export function q8KernelProfileQualified({ profile }: { profile: GpuProfile }): boolean {
  return profile.status === 'complete' && profile.observedPasses === 32 && profile.measuredPasses === 32
    && profile.pendingPasses + profile.invalidPasses + profile.droppedPasses + profile.ungroupedPasses + profile.ambiguousPasses + profile.instrumentationErrors === 0
    && (profile.readbacks?.rows.every(row => row.pending + row.rejected + row.invalidTimings === 0) ?? true)
    && profile.rows.length <= 32 && profile.rows.reduce((sum, row) => sum + row.passes, 0) === 32
    && profile.rows.reduce((sum, row) => sum + row.dispatches, 0) === 32
    && profile.zeroDurationPasses === profile.rows.reduce((sum, row) => sum + row.zeroDurationPasses, 0)
    && profile.rows.every(row => row.passes <= 32 && row.dispatches <= 32 && row.multiDispatchPasses === 0 && row.dispatches === row.passes && row.zeroDurationPasses <= row.passes);
}

export const q8KernelSampleSchema = z.strictObject({
  variant: q8KernelVariantSchema,
  round: z.number().int().min(0).max(3),
  position: z.number().int().min(0).max(5),
  report: q8KernelNativeReportSchema,
  wallMs: milliseconds,
  gpuProfile: boundedProfileSchema,
  timingStatus: z.enum(['measured', 'quantized', 'partial', 'unavailable']),
  gpuMsPerDispatch: milliseconds.optional(),
  readbackMs: milliseconds,
  exact: exactSchema,
});
const pairedSampleSchema = q8KernelSampleSchema.omit({ round: true, position: true }).extend({
  variant: z.enum(q8KernelPairedVariants),
  arm: z.enum(['A', 'B']),
  order: z.enum(['ABBA', 'BAAB']),
  block: z.number().int().min(0).max(7),
  position: z.number().int().min(0).max(3),
  sequence: z.number().int().min(0).max(31),
  callStartedMs: milliseconds,
  callEndedMs: milliseconds,
});
const pairedComparisonSchema = z.strictObject({
  status: z.enum(['complete', 'unsupported', 'cancelled']),
  clock: z.literal('run-relative-performance-now'),
  warmups: z.array(warmupSchema.extend({ variant: z.enum(q8KernelPairedVariants) })).max(2),
  samples: z.array(pairedSampleSchema).max(32),
});
export const q8KernelShapeSchema = z.strictObject({
  k: z.number().int().min(32).max(16384).multipleOf(32),
  m: z.number().int().min(1).max(65536),
  fixture: z.strictObject({
    seed: count,
    weightBytes: count.max(64 * 1024 * 1024 - 1),
    inputBytes: count,
    outputBytes: count,
    weightSha256: sha256,
    inputSha256: sha256,
    expectedSha256: sha256,
    maximumAbsoluteIntegerSum: count.max(2 ** 24 - 1),
  }),
  variants: z.array(z.strictObject({
    variant: q8KernelVariantSchema,
    prepare: callSchema,
    warmup: warmupSchema.optional(),
  })).max(6),
  samples: z.array(q8KernelSampleSchema).max(24),
  pairedComparison: pairedComparisonSchema.optional(),
  inputsUnchanged: z.strictObject({
    weights: z.literal(true),
    input: z.literal(true),
    guards: z.literal(true),
    weightBytes: count,
    inputBytes: count,
    weightSha256: sha256,
    inputSha256: sha256,
  }).optional(),
});
const progressFields = {
  shapeIndex: z.number().int().min(0).max(7),
  shapeCount: z.literal(8),
  phase: z.enum(['preparing', 'warming', 'measuring', 'verifying']),
};
export const q8KernelBenchmarkProgressSchema = z.union([z.strictObject({
  ...progressFields,
  completedSamples: z.number().int().min(0).max(192),
  totalSamples: z.literal(192),
}), z.strictObject({
  ...progressFields,
  section: z.enum(['base', 'paired']),
  completedSamples: z.number().int().min(0).max(256),
  totalSamples: z.literal(256),
  baseCompletedSamples: z.number().int().min(0).max(192),
  pairedCompletedSamples: z.number().int().min(0).max(64),
}).superRefine((progress, context) => {
  if (progress.completedSamples !== progress.baseCompletedSamples + progress.pairedCompletedSamples) {
    context.addIssue({ code: 'custom', message: 'Q8 progress sample totals differ' });
  }
})]);
export type Q8KernelBenchmarkProgress = z.infer<typeof q8KernelBenchmarkProgressSchema>;
export const q8KernelBenchmarkSchema = z.strictObject({
  version: z.literal(1),
  fixtureId: z.literal('q8-dyadic-v1'),
  status: z.enum(['complete', 'partial', 'cancelled']),
  repetitions: z.literal(32),
  rounds: z.literal(4),
  pairedComparisonProtocol: z.literal('abba-baab-v1').optional(),
  shapes: z.array(q8KernelShapeSchema).max(8),
}).superRefine((value, context) => {
  const invalid = ({ message }: { message: string }) => context.addIssue({ code: 'custom', message });
  const hasUnsupported = value.shapes.some(shape => shape.variants.some(row => row.prepare.report.status === 'unsupported' || row.warmup?.call.report.status === 'unsupported')
    || shape.pairedComparison?.status === 'unsupported');
  if (value.status === 'complete' && hasUnsupported || value.status === 'partial' && !hasUnsupported) {
    invalid({ message: 'Inconsistent Q8 completion status' });
  }
  if (value.status !== 'cancelled' && value.shapes.length !== 8) {
    invalid({ message: 'Incomplete Q8 shape set' });
  }
  let previousPairedCallEnd = 0;
  const pairedSchedule = value.pairedComparisonProtocol ? createQ8KernelPairedSchedule({ blocks: 8 }) : [];
  for (const [index, shape] of value.shapes.entries()) {
    const expected = q8KernelShapes[index];
    if (!expected || shape.k !== expected[0] || shape.m !== expected[1]) {
      invalid({ message: 'Unexpected Q8 shape order' });
    }
    if (shape.fixture.weightBytes !== shape.k / 32 * 34 * shape.m || shape.fixture.inputBytes !== shape.k * 4 || shape.fixture.outputBytes !== shape.m * 4
      || shape.fixture.maximumAbsoluteIntegerSum !== shape.k * 64) {
      invalid({ message: 'Invalid Q8 fixture dimensions' });
    }
    if (value.status !== 'cancelled' && (shape.variants.length !== 6 || !shape.inputsUnchanged)) {
      invalid({ message: 'Incomplete Q8 shape verification' });
    }
    for (const [position, variant] of shape.variants.entries()) {
      if (variant.variant !== q8KernelVariants[position] || variant.prepare.report.variant !== variant.variant || variant.prepare.report.phase !== 'prepare'
        || variant.prepare.report.dispatches !== 0) {
        invalid({ message: 'Unexpected Q8 variant preparation' });
      }
      const warmup = variant.warmup;
      if (variant.prepare.report.status === 'ok' && value.status !== 'cancelled' && (!warmup || warmup.call.report.status === 'ok' && (!warmup.exact || warmup.readbackMs === undefined))) {
        invalid({ message: 'Unverified Q8 warmup' });
      }
      if (warmup && (warmup.call.report.variant !== variant.variant || warmup.call.report.phase !== 'execute'
        || warmup.call.report.dispatches !== ({ ok: 1, unsupported: 0, unavailable: 0, 'bad-request': 0, 'not-prepared': 0, busy: 0 }[warmup.call.report.status]))) {
        invalid({ message: 'Invalid Q8 warmup report' });
      }
      if (variant.prepare.report.status !== 'ok' && warmup || warmup?.call.report.status === 'ok' && reportIdentity({ report: warmup.call.report }) !== reportIdentity({ report: variant.prepare.report })) {
        invalid({ message: 'Q8 warmup identity changed' });
      }
      if (warmup?.exact && (warmup.exact.words !== shape.m || warmup.exact.actualSha256 !== shape.fixture.expectedSha256 || warmup.exact.expectedSha256 !== shape.fixture.expectedSha256)) {
        invalid({ message: 'Q8 exact comparison differs' });
      }
      if (warmup?.call.report.status === 'unsupported' && (warmup.exact || warmup.readbackMs !== undefined)) {
        invalid({ message: 'Unsupported Q8 warmup has successful readback evidence' });
      }
    }
    const ready = new Set(shape.variants.filter(variant => variant.warmup?.call.report.status === 'ok' && variant.warmup.exact).map(variant => variant.variant));
    const schedule = Array.from({ length: 4 }, (_, round) => (round % 2 ? [...q8KernelVariants].reverse() : [...q8KernelVariants])
      .flatMap((variant, position) => ready.has(variant) ? [{ variant, position, round }] : [])).flat();
    if (value.status !== 'cancelled' && shape.samples.length !== schedule.length) {
      invalid({ message: 'Incomplete Q8 sample schedule' });
    }
    for (const [sampleIndex, sample] of shape.samples.entries()) {
      const qualified = q8KernelProfileQualified({ profile: sample.gpuProfile });
      const expectedTimingStatus = qualified ? sample.gpuProfile.zeroDurationPasses ? 'quantized' : 'measured' : sample.gpuProfile.measuredPasses ? 'partial' : 'unavailable';
      if (sample.timingStatus !== expectedTimingStatus) {
        invalid({ message: 'Inconsistent Q8 timing status' });
      }
      const expectedSample = schedule[sampleIndex];
      if (!expectedSample || sample.variant !== expectedSample.variant || sample.round !== expectedSample.round || sample.position !== expectedSample.position
        || sample.report.variant !== sample.variant || sample.report.phase !== 'execute' || sample.report.dispatches !== 32 || sample.report.status !== 'ok') {
        invalid({ message: 'Unexpected Q8 sample order or dispatches' });
      }
      const prepared = shape.variants.find(variant => variant.variant === sample.variant)?.prepare.report;
      if (!prepared || reportIdentity({ report: prepared }) !== reportIdentity({ report: sample.report })) {
        invalid({ message: 'Q8 shader identity changed' });
      }
      if ((sample.timingStatus === 'measured' || sample.timingStatus === 'quantized') && (!qualified
        || sample.gpuMsPerDispatch !== sample.gpuProfile.totalGpuMs / 32 || (sample.timingStatus === 'quantized') !== (sample.gpuProfile.zeroDurationPasses > 0))) {
        invalid({ message: 'Invalid Q8 timestamp evidence' });
      }
      if (sample.exact.words !== shape.m || sample.exact.expectedSha256 !== shape.fixture.expectedSha256 || sample.exact.actualSha256 !== shape.fixture.expectedSha256) {
        invalid({ message: 'Unverified Q8 measured output' });
      }
      if ((sample.timingStatus === 'partial' || sample.timingStatus === 'unavailable') && sample.gpuMsPerDispatch !== undefined) {
        invalid({ message: 'Unqualified Q8 per-dispatch timing' });
      }
    }
    const paired = shape.pairedComparison;
    const pairedShape = q8KernelPairedShapes.some(([k, m]) => shape.k === k && shape.m === m);
    const hasLaterShape = index < value.shapes.length - 1;
    if (paired && (!value.pairedComparisonProtocol || !pairedShape)
      || value.pairedComparisonProtocol && pairedShape && (value.status !== 'cancelled' || hasLaterShape) && !paired
      || value.pairedComparisonProtocol && pairedShape && hasLaterShape && !shape.inputsUnchanged) {
      invalid({ message: 'Unexpected or missing Q8 paired comparison' });
    }
    if (paired) {
      const pairReady = q8KernelPairedVariants.every(variant => ready.has(variant));
      const pairUnsupported = !pairReady || paired.warmups.some(warmup => warmup.call.report.status === 'unsupported');
      if (paired.status === 'cancelled' && (value.status !== 'cancelled' || hasLaterShape) || paired.status === 'unsupported' && !pairUnsupported
        || paired.status === 'complete' && (pairUnsupported || paired.warmups.length !== 2 || paired.samples.length !== 32)
        || paired.status === 'unsupported' && paired.samples.length !== 0
        || shape.samples.length !== schedule.length) {
        invalid({ message: 'Inconsistent Q8 paired completion or base prefix' });
      }
      for (const [warmupIndex, warmup] of paired.warmups.entries()) {
        const variant = q8KernelPairedVariants[warmupIndex];
        const prepared = shape.variants.find(row => row.variant === variant)?.prepare.report;
        if (!pairReady || warmup.variant !== variant || warmup.call.report.variant !== variant || warmup.call.report.phase !== 'execute'
          || warmup.call.report.dispatches !== ({ ok: 1, unsupported: 0, unavailable: 0, 'bad-request': 0, 'not-prepared': 0, busy: 0 }[warmup.call.report.status])
          || !prepared || warmup.call.report.status === 'ok' && reportIdentity({ report: warmup.call.report }) !== reportIdentity({ report: prepared })
          || warmup.call.report.status === 'unsupported' && (warmup.exact || warmup.readbackMs !== undefined || warmupIndex !== paired.warmups.length - 1)
          || warmup.exact && warmup.readbackMs === undefined
          || warmup.call.report.status === 'ok' && (!warmup.exact || warmup.readbackMs === undefined)
            && (paired.status !== 'cancelled' || warmupIndex !== paired.warmups.length - 1)) {
          invalid({ message: 'Invalid Q8 paired warmup prefix' });
        }
        if (warmup.exact && (warmup.exact.words !== shape.m || warmup.exact.actualSha256 !== shape.fixture.expectedSha256
          || warmup.exact.expectedSha256 !== shape.fixture.expectedSha256)) {
          invalid({ message: 'Unverified Q8 paired warmup' });
        }
      }
      if (paired.samples.length && (paired.warmups.length !== 2 || paired.warmups.some(warmup => warmup.call.report.status !== 'ok' || !warmup.exact || warmup.readbackMs === undefined))) {
        invalid({ message: 'Q8 paired samples precede verified warmups' });
      }
      for (const [sampleIndex, sample] of paired.samples.entries()) {
        const expectedSample = pairedSchedule[sampleIndex];
        const prepared = shape.variants.find(row => row.variant === sample.variant)?.prepare.report;
        const qualified = q8KernelProfileQualified({ profile: sample.gpuProfile });
        const timingStatus = qualified ? sample.gpuProfile.zeroDurationPasses ? 'quantized' : 'measured' : sample.gpuProfile.measuredPasses ? 'partial' : 'unavailable';
        if (!expectedSample || sample.arm !== expectedSample.arm || sample.order !== expectedSample.order || sample.block !== expectedSample.block
          || sample.position !== expectedSample.position || sample.sequence !== expectedSample.sequence || sample.variant !== expectedSample.variant
          || sample.report.variant !== sample.variant || sample.report.status !== 'ok' || sample.report.phase !== 'execute' || sample.report.dispatches !== 32
          || !prepared || reportIdentity({ report: sample.report }) !== reportIdentity({ report: prepared })) {
          invalid({ message: 'Invalid Q8 paired order or identity' });
        }
        if (sample.callStartedMs < previousPairedCallEnd || sample.callEndedMs < sample.callStartedMs
          || sample.wallMs !== sample.callEndedMs - sample.callStartedMs) {
          invalid({ message: 'Invalid Q8 paired monotonic call interval' });
        }
        previousPairedCallEnd = sample.callEndedMs;
        if (sample.timingStatus !== timingStatus || (qualified ? sample.gpuMsPerDispatch !== sample.gpuProfile.totalGpuMs / 32 : sample.gpuMsPerDispatch !== undefined)
          || sample.exact.words !== shape.m || sample.exact.expectedSha256 !== shape.fixture.expectedSha256 || sample.exact.actualSha256 !== shape.fixture.expectedSha256) {
          invalid({ message: 'Invalid Q8 paired timing or exact evidence' });
        }
      }
    }
    if (shape.inputsUnchanged && (shape.inputsUnchanged.weightBytes !== shape.fixture.weightBytes || shape.inputsUnchanged.inputBytes !== shape.fixture.inputBytes
      || shape.inputsUnchanged.weightSha256 !== shape.fixture.weightSha256 || shape.inputsUnchanged.inputSha256 !== shape.fixture.inputSha256)) {
      invalid({ message: 'Q8 input preservation differs' });
    }
  }
});
export type Q8KernelBenchmark = z.infer<typeof q8KernelBenchmarkSchema>;
export type Q8KernelShape = z.infer<typeof q8KernelShapeSchema>;
export type Q8KernelSample = z.infer<typeof q8KernelSampleSchema>;

export const TEST_ONLY = {
};
