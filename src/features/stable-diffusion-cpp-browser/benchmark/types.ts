import { z } from 'zod';
import { artifactSchema, parametersSchema, previewSettingsSchema, requestSchema, weightResidencySchema, modelSlotSchema } from '@/features/stable-diffusion-cpp-browser/types';
import type { Request, Parameters } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageBenchmarkTarget } from '@/features/stable-diffusion-cpp-browser/library-view';

export const MAX_BENCHMARK_RUNS = 100;
export const MAX_BENCHMARK_IMAGE_BYTES = 128 * 1024 ** 2;
export const protocolSchema = z.object({
  mode: z.enum(['cold-warm', 'fresh-each']), repeats: z.number().int().min(1).max(10),
  order: z.enum(['listed', 'reverse']), cooldownSeconds: z.number().int().min(0).max(60),
  timeoutSeconds: z.number().int().min(0).max(7200), keepImages: z.boolean(),
}).strict();
export type BenchmarkProtocol = z.infer<typeof protocolSchema>;
export type ParameterChange = { [K in keyof Parameters]: { key: K, value: Parameters[K] } }[keyof Parameters];
export type BenchmarkModelPlan = { target: ImageBenchmarkTarget, request: Request, overrides: Partial<Parameters>, preset: string | undefined };
export type BenchmarkPlan = { id: string, createdAt: string, appVersion: string, notes: string, protocol: BenchmarkProtocol, models: BenchmarkModelPlan[] };
const nonnegative = z.number().finite().nonnegative();
const fieldsSchema = z.record(z.string().max(64), z.union([z.number().finite(), z.string().max(512), z.boolean(), z.array(z.number().finite()).max(8)]));
export const measurementSchema = z.object({
  diagnosticsReceived: nonnegative, invalidDiagnostics: nonnegative, omittedDiagnostics: nonnegative,
  runWall: fieldsSchema.optional(), reuse: z.object({ reusedWorker: z.boolean(), reason: z.string() }).optional(),
  steps: z.array(z.object({ step: nonnegative, milliseconds: nonnegative })).max(100),
  fileRead: z.object({ reads: nonnegative, bytes: nonnegative, blobReads: nonnegative, blobBytes: nonnegative }).optional(),
}).strict();
export type BenchmarkMeasurements = z.infer<typeof measurementSchema>;
export const runRecordSchema = z.object({
  id: z.string(), modelIndex: nonnegative, runIndex: nonnegative, plannedKind: z.enum(['cold', 'warm']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'skipped']),
  startedAt: z.string().optional(), endedAt: z.string().optional(), elapsedMs: nonnegative.optional(),
  metrics: measurementSchema, error: z.string().max(4096).optional(), skipReason: z.string().optional(),
  modelVersion: z.string().max(256).optional(), uniformOutput: z.boolean().optional(),
  image: z.object({ status: z.enum(['not-requested', 'retained', 'budget-exceeded', 'no-output']), bytes: nonnegative }),
  previewFrames: nonnegative, hiddenObserved: z.boolean(), visibilityChanges: nonnegative,
}).strict();
export type BenchmarkRunRecord = z.infer<typeof runRecordSchema>;
export type BenchmarkRun = { record: BenchmarkRunRecord, diagnostics: string, png: Blob | undefined };
export type BenchmarkSnapshot = { plan: BenchmarkPlan, runs: BenchmarkRun[], state: 'running' | 'finished' | 'cancelled' };

const fileMetadataSchema = z.object({ path: z.string(), bytes: nonnegative, lastModified: nonnegative }).strict();
export const exportedModelSchema = z.object({
  index: nonnegative, id: z.string(), label: z.string(), detail: z.string(), family: z.string(), variant: z.string(),
  evidence: z.array(z.string()), composition: z.enum(['selected', 'automatic']), preset: z.string().optional(), overrideKeys: z.array(z.string()),
  request: z.object({ artifact: artifactSchema, parameters: parametersSchema.omit({ prompt: true, negativePrompt: true }),
    prompt: z.string().optional(), negativePrompt: z.string().optional(), promptsIncluded: z.boolean(),
    preview: previewSettingsSchema, weightResidency: weightResidencySchema, gpuBudgetMiB: requestSchema.shape.gpuBudgetMiB,
    debug: z.literal('on'), models: z.array(z.object({ slot: modelSlotSchema, localCandidateId: z.string(), files: z.array(fileMetadataSchema) }).strict()),
  }).strict(),
}).strict();
export const aggregateSchema = z.array(z.object({
  modelIndex: nonnegative, label: z.string(), warmSamples: nonnegative, coldSamples: nonnegative,
  warmMedianMs: nonnegative.optional(), coldMedianMs: nonnegative.optional(),
  succeeded: nonnegative, failed: nonnegative, missingReuseEvidence: nonnegative,
}).strict()).max(MAX_BENCHMARK_RUNS);
export const manifestSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('naidan-image-benchmark'), id: z.string(), appVersion: z.string(), createdAt: z.string(), exportedAt: z.string(),
  state: z.enum(['running', 'finished', 'cancelled']), notes: z.string().max(2048), protocol: protocolSchema,
  models: z.array(exportedModelSchema), runs: z.array(runRecordSchema).max(MAX_BENCHMARK_RUNS),
  limitations: z.array(z.string()),
}).strict();
export const TEST_ONLY = {
};
