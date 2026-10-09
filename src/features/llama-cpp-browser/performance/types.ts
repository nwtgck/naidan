import { memoryDiagnosticsSchema } from './memory-schema';
import { z } from 'zod';
import { diagnosticSchema } from '@/features/llama-cpp-browser/debug-log';
import { generationResultSchema, modelSchema, progressSchema, runtimeOptionsSchema } from '@/features/llama-cpp-browser/types';

export const performanceProtocol = 'targeted-text-en-v3' as const;

const idSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).max(128);
const milliseconds = z.number().finite().nonnegative();
export const protocolSchema = z.object({
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
  protocol: z.literal(performanceProtocol),
  id: idSchema,
  createdAt: z.string(),
  models: z.array(modelSchema).min(1).max(16),
  settings: protocolSchema,
  options: runtimeOptionsSchema,
  notes: z.string().max(10000),
  steps: z.array(stepSchema).min(1).max(1024),
}).strict();
export const trialSchema = z.object({
  id: idSchema,
  stepId: idSchema,
  modelIndex: z.number().int().nonnegative(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'skipped']),
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
  warnings: z.array(z.enum(['incomplete-parent', 'placement-layout-only', 'placement-missing', 'placement-incomplete'])),
  exclusion: z.array(z.enum(['page-hidden', 'missing-summary', 'incomplete-summary', 'unexpected-reuse', 'incomplete-output', 'failed', 'instrumented'])),
}).strict();
const intervalSchema = z.object({
  modelIndex: z.number().int().nonnegative(),
  stepId: idSchema.optional(),
  kind: z.enum(['visibility-wait', 'model-inventory', 'model-acquire', 'model-release']),
  startedMs: milliseconds,
  elapsedMs: milliseconds,
  hiddenAtStart: z.boolean(),
  outcome: z.enum(['completed', 'failed', 'cancelled']),
}).strict();
export const snapshotSchema = z.object({
  execution: z.object({
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    elapsedMs: milliseconds.optional(),
    intervals: z.array(intervalSchema).max(2048),
    visibility: z.array(z.object({ atMs: milliseconds, hidden: z.boolean() }).strict()).max(256),
    droppedVisibilityEvents: z.number().int().nonnegative(),
  }).strict().optional(),
  plan: planSchema,
  environment: z.object({
    appVersion: z.string(),
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
  modelErrors: z.array(z.object({ modelIndex: z.number().int().nonnegative(), error: z.string() }).strict()),
}).strict();
export type PerformancePlan = z.infer<typeof planSchema>;
export type PerformanceStep = z.infer<typeof stepSchema>;
export type PerformanceTrial = z.infer<typeof trialSchema>;
export type PerformanceSnapshot = z.infer<typeof snapshotSchema>;
export const TEST_ONLY = {
};
