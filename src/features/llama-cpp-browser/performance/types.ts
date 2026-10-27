import { memoryDiagnosticsSchema } from './memory-schema';
import { q8DiagnosticObservationSchema } from './q8-diagnostic-observation';
import { z } from 'zod';
import { diagnosticSchema } from '@/features/llama-cpp-browser/debug-log';
import { generationResultSchema, gpuProfilingProfile, modelSchema, progressSchema, runtimeOptionsSchema } from '@/features/llama-cpp-browser/types';

export const performanceProtocol = 'targeted-text-en-v4' as const;
export const measurementModeSchema = z.enum(['gpu-profile', 'standard', 'both']);
export const measurementLaneSchema = z.enum(['standard', 'gpu-profile']);
export type MeasurementMode = z.infer<typeof measurementModeSchema>;
export type MeasurementLane = z.infer<typeof measurementLaneSchema>;

export function measurementLanes({ mode }: { mode: MeasurementMode | undefined }): MeasurementLane[] {
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
}).strict();
export const textMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  reasoning_content: z.string().optional(),
}).strict();
export const stepSchema = z.object({
  id: idSchema,
  modelIndex: z.number().int().nonnegative(),
  lane: measurementLaneSchema.optional(),
  scenario: z.enum(['initial', 'short', 'long', 'continuation', 'placement']),
  position: z.enum(['initial', 'before', 'after', 'workload', 'diagnostic']),
  maxTokens: z.number().int().min(1).max(512),
  role: z.enum(['measurement', 'preparation']),
  repetition: z.number().int().nonnegative(),
  sequence: z.enum(['fresh', 'continue']),
  dependsOn: idSchema.optional(),
  prompt: z.string(),
}).strict();
export const planSchema = z.object({
  version: z.literal(1),
  protocol: z.enum(['targeted-text-en-v3', performanceProtocol]),
  id: idSchema,
  createdAt: z.string(),
  models: z.array(modelSchema).min(1).max(16),
  settings: protocolSchema,
  options: runtimeOptionsSchema,
  notes: z.string().max(10000),
  steps: z.array(stepSchema).min(1).max(1024),
}).strict().superRefine((plan, context) => {
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
  const allowed = measurementLanes({ mode: plan.settings.mode });
  const seen = new Map<string, typeof plan.steps[number]>();
  for (const step of plan.steps) {
    if (!allowed.includes(step.lane ?? 'standard')) {
      context.addIssue({ code: 'custom', message: 'Measurement lane does not match the selected mode' });
    }

    if (seen.has(step.id) || step.modelIndex >= plan.models.length) {
      context.addIssue({ code: 'custom', message: 'Invalid measurement step identity' });
    }
    if (step.dependsOn !== undefined) {
      const parent = seen.get(step.dependsOn);
      if (!parent || parent.modelIndex !== step.modelIndex || (parent.lane ?? 'standard') !== (step.lane ?? 'standard')) {
        context.addIssue({ code: 'custom', message: 'Continuation crosses a model or runtime lane' });
      }
    }
    seen.set(step.id, step);
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
  skipReason: z.enum(['dependency-interrupted', 'dependency-runtime-reset']).optional(),
  startedAt: z.string(),
  startedMs: milliseconds.optional(),
  elapsedMs: milliseconds.optional(),
  input: z.array(textMessageSchema),
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
  warnings: z.array(z.enum(['incomplete-parent', 'placement-layout-only', 'placement-missing', 'placement-incomplete', 'gpu-profile-missing', 'gpu-profile-incomplete', 'runtime-restarted'])),
  exclusion: z.array(z.enum(['page-hidden', 'missing-summary', 'incomplete-summary', 'unexpected-reuse', 'incomplete-output', 'failed', 'instrumented', 'interrupted', 'dependency-unavailable'])),
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
    // At most five orchestration intervals per planned step after repeated skips.
    intervals: z.array(intervalSchema).max(8192),
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
  modelErrors: z.array(z.object({ modelIndex: z.number().int().nonnegative(), lane: measurementLaneSchema.optional(), error: z.string() }).strict()),
}).strict();
export type PerformancePlan = z.infer<typeof planSchema>;
export type PerformanceStep = z.infer<typeof stepSchema>;
export type PerformanceTrial = z.infer<typeof trialSchema>;
export type PerformanceSnapshot = z.infer<typeof snapshotSchema>;
export const TEST_ONLY = {
};
