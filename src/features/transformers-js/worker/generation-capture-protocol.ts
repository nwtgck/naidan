import { z } from 'zod';
import type { TransformersJsWorkerClient } from '@/features/transformers-js/types';
import { generationCaptureContextSchema, generationCaptureLimitsSchema, generationCaptureTakeResultSchema } from './generation-capture';
import { productionLoadObservationSchema } from './load-receipt';

// Attached only by an investigation-owned client to the existing generate RPC.
// It grants recording capacity, not model/network/storage authority.
export const generationCaptureRequestSchema = z.object({
  context: generationCaptureContextSchema,
  limits: generationCaptureLimitsSchema,
}).strict();
export type GenerationCaptureRequest = z.infer<typeof generationCaptureRequestSchema>;

export const generationCaptureReadRequestSchema = generationCaptureContextSchema.pick({ runId: true, workerEpoch: true });
export type GenerationCaptureReadRequest = z.infer<typeof generationCaptureReadRequestSchema>;

export const generationCaptureReadResultSchema = z.discriminatedUnion('status', [
  generationCaptureTakeResultSchema.options[0].extend({ loadObservation: productionLoadObservationSchema.optional() }),
  generationCaptureTakeResultSchema.options[1],
  z.object({ status: z.literal('not-started'), loadObservation: productionLoadObservationSchema.optional() }).strict(),
]);
export type GenerationCaptureReadResult = z.infer<typeof generationCaptureReadResultSchema>;

export interface GenerationCaptureClientLifetime {
  runId: string;
  workerEpoch: number;
  session: 'active' | 'inactive';
  issuedCalls: GenerationCaptureRequest['context'][];
  loadRequests: Array<{
    requestedModelId: string;
    requestedRevision: string | undefined;
    /** Older recordings omit selection and retain their pinned-revision meaning. */
    revisionSelection?: import('@/features/transformers-js/runtime/downloaded-model-revision-selection').DownloadedModelRevisionSelection;
  }>;
  incompleteReasons: Array<'request-unavailable' | 'request-invalid' | 'call-limit' | 'load-limit' | 'load-identity-limit'>;
}

/** Host-owned diagnostic view, separate from the ordinary service client API. */
export interface GenerationCaptureClient {
  client: TransformersJsWorkerClient;
  takeGenerationCapture(): Promise<GenerationCaptureReadResult>;
  getCaptureLifetime(): GenerationCaptureClientLifetime;
}

export const TEST_ONLY = {
};
