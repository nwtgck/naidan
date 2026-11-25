import { visionAdmissionSchema } from './vision-admission-schema';
import { visionFixtureSchema, visionPrompt, visionProtocol, visionTrialSchema } from './vision-plan';
import { memoryDiagnosticsSchema } from './memory-schema';
import { q8DiagnosticObservationSchema } from './q8-diagnostic-observation';
import { z } from 'zod';
import { diagnosticSchema } from '@/features/llama-cpp-browser/debug-log';
import { generateInputSchema, generationResultSchema, gpuProfilingProfile, modelSchema, progressSchema, runtimeOptionsSchema, toolCallSchema } from '@/features/llama-cpp-browser/types';
import { toolCallPrompt, toolCallTokenLimit, toolContinuationTokenLimit, toolResult } from './tool-continuation';
import { swaCacheLanes, swaCacheProtocol, swaCacheSteps } from './swa-cache';

export const maximumExecutionIntervals = 8192;

export const performanceProtocol = 'targeted-text-en-v5' as const;
export const measurementModeSchema = z.enum(['gpu-profile', 'standard', 'both']);
export const measurementLaneSchema = z.enum(['standard', 'gpu-profile', 'q2-baseline', 'q2-gpu', ...swaCacheLanes]);
export type MeasurementMode = z.infer<typeof measurementModeSchema>;
export type MeasurementLane = z.infer<typeof measurementLaneSchema>;

export function measurementLanes({ mode, q2Placement, swaCache }: { mode: MeasurementMode | undefined, q2Placement?: 'ab' | undefined, swaCache?: 'ab' | undefined }): MeasurementLane[] {
  if (swaCache !== undefined) {
    return [...swaCacheLanes];
  }
  if (q2Placement !== undefined) {
    return ['q2-baseline', 'q2-gpu'];
  }
  switch (mode) {
  case 'both': return ['standard', 'gpu-profile'];
  case 'standard': case undefined: return ['standard'];
  case 'gpu-profile': return ['gpu-profile'];
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
}

const idSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).max(128);
const milliseconds = z.number().finite().nonnegative();
export const protocolSchema = z.object({
  // Missing in v3 archives: those always used an ordinary runtime.
  mode: measurementModeSchema.optional(),
  repeats: z.number().int().min(1).max(5),
  maxTokens: z.number().int().min(1).max(512),
  timeoutMs: z.number().int().min(1000).max(3600000),
  diagnostics: z.enum(['none', 'placement']).optional(),
  q2Placement: z.literal('ab').optional(),
  swaCache: z.literal('ab').optional(),
}).strict();
const textMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string() }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string(), reasoning_content: z.string().optional(), tool_calls: z.array(toolCallSchema).optional() }).strict(),
  z.object({ role: z.literal('tool'), content: z.string(), tool_call_id: z.string(), name: z.string() }).strict(),
]);
export const stepSchema = z.object({
  id: idSchema,
  modelIndex: z.number().int().nonnegative(),
  lane: measurementLaneSchema.optional(),
  scenario: z.enum(['initial', 'short', 'long', 'continuation', 'placement', 'tool-call', 'tool-continuation']),
  position: z.enum(['initial', 'before', 'after', 'workload', 'diagnostic']),
  maxTokens: z.number().int().min(1).max(512),
  role: z.enum(['measurement', 'preparation']),
  repetition: z.number().int().nonnegative(),
  sequence: z.enum(['fresh', 'continue']),
  dependsOn: idSchema.optional(),
  prompt: z.string(),
  vision: visionTrialSchema.optional(),
}).strict();
export const planSchema = z.object({
  version: z.literal(1),
  protocol: z.enum(['targeted-text-en-v3', 'targeted-text-en-v4', performanceProtocol, visionProtocol, swaCacheProtocol]),
  visionFixture: visionFixtureSchema.optional(),
  id: idSchema,
  createdAt: z.string(),
  models: z.array(modelSchema).min(1),
  settings: protocolSchema,
  options: runtimeOptionsSchema,
  notes: z.string().max(10000),
  steps: z.array(stepSchema).min(1),
}).strict().superRefine((plan, context) => {
  const q2Placement = plan.settings.q2Placement !== undefined;
  const swaCache = plan.settings.swaCache !== undefined;
  if (swaCache !== (plan.protocol === swaCacheProtocol) || (swaCache && (q2Placement || plan.settings.mode !== 'standard'
    || plan.settings.diagnostics !== 'none' || plan.options.profile !== 'webgpu-wasm64-jspi'))) {
    context.addIssue({ code: 'custom', message: 'SWA cache comparison requires the ordinary text WebGPU profile and exclusive lanes' });
  }
  if (q2Placement && (plan.protocol !== performanceProtocol || plan.settings.mode !== 'standard' || plan.settings.diagnostics !== 'placement'
    || plan.options.profile !== 'webgpu-wasm64-jspi')) {
    context.addIssue({ code: 'custom', message: 'Q2 placement comparison requires the ordinary text WebGPU profile' });
  }
  if (plan.options.profile === gpuProfilingProfile) {
    context.addIssue({ code: 'custom', message: 'Select the profiling measurement mode, not a diagnostic chat profile' });
  }
  switch (plan.settings.mode) {
  case 'both': case 'gpu-profile':
    switch (plan.options.profile) {
    case 'webgpu-wasm64-jspi': break;
    case 'auto': case 'cpu-wasm32': case 'webgpu-wasm32-jspi': case 'webgpu-wasm32-asyncify': case 'webgpu-wasm64-jspi-gpu-profile':
      context.addIssue({ code: 'custom', message: 'GPU profiling requires the ordinary wasm64/JSPI reference profile' });
      break;
    default: {
      const exhaustive: never = plan.options.profile;
      throw new Error(String(exhaustive));
    }
    }
    break;
  case 'standard': case undefined: break;
  default: {
    const exhaustive: never = plan.settings.mode;
    throw new Error(String(exhaustive));
  }
  }
  if ((plan.protocol === visionProtocol) !== (plan.visionFixture !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Image protocol requires its fixed fixture metadata' });
  }
  const allowed = measurementLanes({ mode: plan.settings.mode, q2Placement: plan.settings.q2Placement, swaCache: plan.settings.swaCache });
  if (swaCache) {
    const expected = swaCacheSteps({ modelCount: plan.models.length, repeats: plan.settings.repeats, maxTokens: plan.settings.maxTokens });
    if (expected.length !== plan.steps.length || expected.some((step, index) => {
      const actual = plan.steps[index];
      return !actual || actual.id !== step.id || actual.modelIndex !== step.modelIndex || actual.lane !== step.lane
        || actual.scenario !== step.scenario || actual.position !== step.position || actual.repetition !== step.repetition
        || actual.prompt !== step.prompt || actual.maxTokens !== step.maxTokens || actual.dependsOn !== step.dependsOn
        || actual.role !== step.role || actual.sequence !== step.sequence;
    })) {
      context.addIssue({ code: 'custom', message: 'SWA cache comparison requires the same ordered text workloads for both cache modes' });
    }
  }
  if (q2Placement) {
    const expected = [
      { scenario: 'initial', position: 'initial', repetition: 0, maxTokens: Math.min(8, plan.settings.maxTokens) },
      ...Array.from({ length: plan.settings.repeats }, (_, index) => [
        { scenario: 'short', position: 'before', repetition: index + 1, maxTokens: plan.settings.maxTokens },
        { scenario: 'long', position: 'workload', repetition: index + 1, maxTokens: Math.min(8, plan.settings.maxTokens) },
        { scenario: 'short', position: 'after', repetition: index + 1, maxTokens: plan.settings.maxTokens },
      ]).flat(),
      { scenario: 'placement', position: 'diagnostic', repetition: 0, maxTokens: 2 },
    ];
    const laneLength = expected.length;
    const modelLength = laneLength * allowed.length;
    if (plan.steps.length !== plan.models.length * modelLength || plan.steps.some((step, index) => {
      const lane = allowed[Math.floor((index % modelLength) / laneLength)];
      const shape = expected[index % laneLength];
      return !shape || step.modelIndex !== Math.floor(index / modelLength) || step.lane !== lane
        || step.role !== 'measurement' || step.dependsOn !== undefined || step.sequence !== 'fresh'
        || step.scenario !== shape.scenario || step.position !== shape.position || step.repetition !== shape.repetition || step.maxTokens !== shape.maxTokens
        || (lane === 'q2-gpu' && step.prompt !== plan.steps[index - laneLength]?.prompt);
    })) {
      context.addIssue({ code: 'custom', message: 'Q2 placement comparison requires both matching text workloads for every model' });
    }
  }
  if (plan.protocol === visionProtocol) {
    const expected = plan.models.flatMap((_, modelIndex) => allowed.flatMap(lane => Array.from({ length: plan.settings.repeats + 1 }, (_, repetition) => ({ modelIndex, lane, repetition }))));
    if (plan.settings.diagnostics !== 'none' || expected.length !== plan.steps.length || expected.some((value, index) => {
      const actual = plan.steps[index];
      return actual?.modelIndex !== value.modelIndex || actual.lane !== value.lane || actual.repetition !== value.repetition;
    })) {
      context.addIssue({ code: 'custom', message: 'Image workload order must contain an initial request followed by its resident requests' });
    }
  }
  const seen = new Map<string, typeof plan.steps[number]>();
  const toolLane = allowed[0];
  const toolCalls = new Set<number>();
  let previous: PerformanceStep | undefined;
  for (const step of plan.steps) {
    if (plan.protocol === visionProtocol) {
      if (!step.vision || step.dependsOn !== undefined || step.sequence !== 'fresh' || step.prompt !== visionPrompt
        || step.maxTokens !== Math.min(32, plan.settings.maxTokens) || step.role !== 'measurement'
        || step.scenario !== (step.repetition === 0 ? 'initial' : 'short') || step.position !== (step.repetition === 0 ? 'initial' : 'workload')
        || (step.vision.residency === 'cold') !== (step.repetition === 0)) {
        context.addIssue({ code: 'custom', message: 'Invalid image workload step' });
      }
    } else if (step.vision) {
      context.addIssue({ code: 'custom', message: 'Text protocol cannot contain an image workload' });
    }
    if (!allowed.includes(step.lane ?? 'standard')) {
      context.addIssue({ code: 'custom', message: 'Measurement lane does not match the selected mode' });
    }

    if (seen.has(step.id) || step.modelIndex >= plan.models.length) {
      context.addIssue({ code: 'custom', message: 'Invalid measurement step identity' });
    }
    const parent = step.dependsOn === undefined ? undefined : seen.get(step.dependsOn);
    if (step.dependsOn !== undefined) {
      if (!parent || parent.modelIndex !== step.modelIndex || (parent.lane ?? 'standard') !== (step.lane ?? 'standard')) {
        context.addIssue({ code: 'custom', message: 'Continuation crosses a model or runtime lane' });
      }
    }
    switch (step.scenario) {
    case 'tool-call': case 'tool-continuation': {
      const preparation = step.scenario === 'tool-call';
      if (plan.protocol !== performanceProtocol || (step.lane ?? 'standard') !== toolLane
        || step.position !== 'workload' || step.repetition !== 0 || (preparation
        ? step.role !== 'preparation' || step.dependsOn !== undefined || step.sequence !== 'fresh' || step.prompt !== toolCallPrompt
            || step.maxTokens !== toolCallTokenLimit || toolCalls.has(step.modelIndex)
        : step.role !== 'measurement' || !parent || parent !== previous || parent.scenario !== 'tool-call' || step.sequence !== 'continue'
            || step.prompt !== toolResult || step.maxTokens !== Math.min(toolContinuationTokenLimit, plan.settings.maxTokens))) {
        context.addIssue({ code: 'custom', message: 'Invalid tool continuation workload' });
      }
      if (preparation) {
        toolCalls.add(step.modelIndex);
      }
      break;
    }
    case 'initial': case 'short': case 'long': case 'continuation': case 'placement': break;
    default: {
      const exhaustive: never = step.scenario;
      throw new Error(String(exhaustive));
    }
    }
    if (previous?.scenario === 'tool-call' && step.scenario !== 'tool-continuation') {
      context.addIssue({ code: 'custom', message: 'Missing tool continuation after tool call preparation' });
    }
    seen.set(step.id, step);
    previous = step;
  }
  if (previous?.scenario === 'tool-call' || (plan.protocol === performanceProtocol && !q2Placement && toolCalls.size !== plan.models.length)) {
    context.addIssue({ code: 'custom', message: 'Expected one tool round trip per model' });
  }
});
const interruptionSchema = z.object({
  reason: z.literal('user-skip'),
  // Both clocks are relative to the interrupted trial, not the complete run.
  requestedMs: milliseconds,
  settledMs: milliseconds.optional(),
  recovery: z.enum(['pending', 'new-scope', 'not-needed', 'stopped', 'failed']),
}).strict();
export const trialSchema = z.object({
  id: idSchema,
  stepId: idSchema,
  modelIndex: z.number().int().nonnegative(),
  lane: measurementLaneSchema.optional(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'skipped', 'interrupted']),
  interruption: interruptionSchema.optional(),
  // Segment is local to model/lane. Omitted in older archives (segment zero).
  runtimeSegment: z.number().int().nonnegative().optional(),
  skipReason: z.enum(['dependency-interrupted', 'dependency-runtime-reset', 'missing-projector', 'native-no-vision', 'tool-template-unsupported', 'no-usable-tool-call']).optional(),
  startedAt: z.string(),
  startedMs: milliseconds.optional(),
  elapsedMs: milliseconds.optional(),
  input: z.array(textMessageSchema),
  tools: generateInputSchema.shape.tools,
  visionAdmission: visionAdmissionSchema.optional(),
  vision: visionTrialSchema.optional(),
  options: runtimeOptionsSchema,
  output: generationResultSchema.optional(),
  partialText: z.string(),
  partialReasoning: z.string(),
  firstReceivedMs: milliseconds.optional(),
  firstTextMs: milliseconds.optional(),
  firstReasoningMs: milliseconds.optional(),
  lastProgress: progressSchema.optional(),
  lastProgressMs: milliseconds.optional(),
  receivedEvents: z.number().int().nonnegative(),
  maximumDeliveryGapMs: milliseconds.optional(),
  hiddenObserved: z.boolean(),
  summary: diagnosticSchema.optional(),
  memoryDiagnostics: memoryDiagnosticsSchema.optional(),
  error: z.string().optional(),
  warnings: z.array(z.enum(['incomplete-parent', 'placement-layout-only', 'placement-missing', 'placement-incomplete', 'gpu-profile-missing', 'gpu-profile-incomplete', 'runtime-restarted', 'vision-residency-unconfirmed'])),
  exclusion: z.array(z.enum(['page-hidden', 'missing-summary', 'incomplete-summary', 'unexpected-reuse', 'incomplete-output', 'failed', 'instrumented', 'interrupted', 'dependency-unavailable', 'residency-unconfirmed'])),
}).strict();
const intervalSchema = z.object({
  runtimeSegment: z.number().int().nonnegative().optional(),
  modelIndex: z.number().int().nonnegative(),
  lane: measurementLaneSchema.optional(),
  stepId: idSchema.optional(),
  kind: z.enum(['visibility-wait', 'model-inventory', 'model-acquire', 'model-release']),
  startedMs: milliseconds,
  elapsedMs: milliseconds,
  hiddenAtStart: z.boolean(),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
}).strict();
export const snapshotSchema = z.object({
  q8KernelDiagnostic: q8DiagnosticObservationSchema.optional(),
  execution: z.object({
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    elapsedMs: milliseconds.optional(),
    // Evidence remains bounded independently of model/step count. Missing means
    // the older recorder did not report coverage, not proof of zero loss.
    intervals: z.array(intervalSchema).max(maximumExecutionIntervals),
    droppedIntervals: z.number().int().nonnegative().optional(),
    visibility: z.array(z.object({ atMs: milliseconds, hidden: z.boolean() }).strict()).max(256),
    droppedVisibilityEvents: z.number().int().nonnegative(),
  }).strict().optional(),
  plan: planSchema,
  environment: z.object({
    appVersion: z.string(),
    appSource: z.object({
      sourceCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
      workingTree: z.enum(['clean', 'dirty', 'unknown']),
    }).strict(),
    buildMode: z.string(),
    userAgent: z.string(),
    hardwareConcurrency: z.number().int().nonnegative(),
    crossOriginIsolated: z.boolean(),
    timeOrigin: milliseconds,
    runtimeBuild: z.object({
      sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
      files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
    }).strict().optional(),
  }).strict(),
  status: z.enum(['running', 'completed', 'cancelled']),
  trials: z.array(trialSchema),
  modelErrors: z.array(z.object({
    modelIndex: z.number().int().nonnegative(),
    lane: measurementLaneSchema.optional(),
    runtimeSegment: z.number().int().nonnegative().optional(),
    error: z.string(),
  }).strict()),
}).strict();
export type PerformancePlan = z.infer<typeof planSchema>;
export type PerformanceStep = z.infer<typeof stepSchema>;
export type PerformanceTrial = z.infer<typeof trialSchema>;
export type PerformanceSnapshot = z.infer<typeof snapshotSchema>;
export const TEST_ONLY = {
};
