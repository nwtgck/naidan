import { z } from 'zod';
import { runtimeArtifactPreparationResultSchema } from '@/features/transformers-js/runtime/production-resource-plan';
import { runtimeMetadataPreparationStageSchema } from '@/features/transformers-js/download-verification/download-worker/runtime-metadata-preparation-types';
import type { WorkerProxy } from '@/utils/worker-transport';
import { REPLAY_METADATA_PATHS, replayMetadataSummarySchema } from '@/features/transformers-js/model-support-investigation/logic/collect-replay-metadata';

export const FRESH_METADATA_MAX_BYTES = 48 * 1024 * 1024;
export const FRESH_METADATA_MAX_REQUESTS = 64;
export const FRESH_METADATA_TIMEOUT_MS = 60_000;

export const freshMetadataRequestSchema = z.object({
  modelId: z.string().regex(/^[\w.-]+\/[\w.-]+$/u),
  revision: z.string().regex(/^[a-f0-9]{40}$/iu),
  maximumBytes: z.number().int().min(1).max(FRESH_METADATA_MAX_BYTES),
  repositoryFiles: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative().optional() }).strict()).max(10000),
}).strict();
export type FreshMetadataRequest = z.infer<typeof freshMetadataRequestSchema>;

export const freshMetadataHttpObservationSchema = z.object({
  consumer: z.enum(['runtime-preparation', 'replay-supplement']),
  path: z.string(),
  request: z.enum(['full', 'size-probe']),
  status: z.enum(['requesting', 'reading', 'complete', 'cancelling', 'cancelled', 'failed']),
  httpStatus: z.number().int().optional(),
  contentLength: z.number().int().nonnegative().optional(),
  contentRange: z.string().regex(/^bytes \d+-\d+\/\d+$/u).optional(),
  receivedBytes: z.number().int().nonnegative(),
}).strict();
export type FreshMetadataHttpObservation = z.infer<typeof freshMetadataHttpObservationSchema>;

export const freshMetadataSummarySchema = z.object({
  schemaVersion: z.literal(1),
  modelId: z.string(),
  revision: z.string(),
  source: z.literal('fresh-network-memory'),
  status: z.enum(['running', 'prepared', 'failed', 'timeout', 'interrupted', 'not-run']),
  reason: z.string().optional(),
  preparationStage: runtimeMetadataPreparationStageSchema.or(z.literal('worker-initialization')).optional(),
  failureCategory: z.enum(['syntax-error', 'type-error', 'range-error', 'error', 'unknown']).optional(),
  maximumBytes: z.number().int().nonnegative(),
  receivedBytes: z.number().int().nonnegative(),
  requests: z.array(freshMetadataHttpObservationSchema).max(FRESH_METADATA_MAX_REQUESTS),
  preparation: runtimeArtifactPreparationResultSchema.optional(),
}).strict().superRefine((summary, context) => {
  switch (summary.status) {
  case 'prepared':
    if (summary.preparation === undefined) context.addIssue({ code: 'custom', message: 'Prepared metadata must include the runtime preparation result' });
    break;
  case 'running':
  case 'failed':
  case 'timeout':
  case 'interrupted':
  case 'not-run': break;
  default: {
    const _ex: never = summary.status;
    throw new Error(`Unknown fresh metadata status: ${_ex}`);
  }
  }
  if (summary.receivedBytes !== summary.requests.reduce((total, request) => total + request.receivedBytes, 0)) {
    context.addIssue({ code: 'custom', message: 'HTTP observation byte totals are inconsistent' });
  }
});
export type FreshMetadataSummary = z.infer<typeof freshMetadataSummarySchema>;

export const freshMetadataResultSchema = z.object({
  summary: freshMetadataSummarySchema,
  replayMetadata: replayMetadataSummarySchema.optional(),
  files: z.array(z.object({ path: z.enum(REPLAY_METADATA_PATHS), blob: z.instanceof(Blob) }).strict()).max(REPLAY_METADATA_PATHS.length),
}).strict().superRefine(({ summary, replayMetadata, files }, context) => {
  // Progress and final results share observation fields, not lifecycle authority.
  // A Worker returning must not leave the host displaying an active acquisition.
  switch (summary.status) {
  case 'running':
    context.addIssue({ code: 'custom', message: 'A final fresh metadata result cannot still be running' });
    break;
  case 'prepared':
  case 'failed':
  case 'timeout':
  case 'interrupted':
  case 'not-run': break;
  default: {
    const _ex: never = summary.status;
    throw new Error(`Unknown final metadata status: ${_ex}`);
  }
  }
  // Validate the relationship, not only each independently valid JSON object.
  // Otherwise a stale Worker result could attach another revision's raw files.
  if (replayMetadata === undefined) {
    if (files.length !== 0) context.addIssue({ code: 'custom', message: 'Fresh sidecars require a matching replay manifest' });
    return;
  }
  if (replayMetadata.modelId !== summary.modelId || replayMetadata.revision !== summary.revision
    || replayMetadata.budgetBytes !== summary.maximumBytes) {
    context.addIssue({ code: 'custom', message: 'Fresh preparation and replay identity or budget differ' });
  }
  const collected = replayMetadata.files.filter(file => file.status === 'collected');
  const uniquePaths = new Set(files.map(file => file.path));
  if (uniquePaths.size !== files.length || collected.length !== files.length
    || files.some(file => !collected.some(observation => observation.path === file.path && observation.byteLength === file.blob.size))) {
    context.addIssue({ code: 'custom', message: 'Fresh sidecars do not match the collected-file manifest' });
  }
  if (replayMetadata.files.some(file => file.source === 'local-exact')) {
    context.addIssue({ code: 'custom', message: 'Fresh metadata cannot use existing local-cache provenance' });
  }
});
export type FreshMetadataResult = z.infer<typeof freshMetadataResultSchema>;

export interface FreshMetadataWorker {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Remote method with a top-level proxied callback.
  run(
    input: z.infer<typeof freshMetadataRequestSchema>,
    onObservation: WorkerProxy<({ summary }: { summary: FreshMetadataSummary }) => void>,
  ): Promise<FreshMetadataResult>;
}

export const TEST_ONLY = {
};
