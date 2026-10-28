import { z } from 'zod';
import { memoryDiagnosticSchema } from '@/features/llama-cpp-browser/memory-diagnostics';
import { q8KernelBenchmarkProgressSchema, q8KernelBenchmarkSchema } from './q8-kernel-schema';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
export const q8DiagnosticWorkerRequestSchema = z.object({ assetBaseURL: z.url(), schemaAssetSha256: digest }).strict();
export const q8DiagnosticWorkerResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    schemaAssetSha256: digest,
    compiledSchemaSha256: digest,
    setupWallMs: z.number().finite().nonnegative(),
    gpuRequests: memoryDiagnosticSchema.shape.gpuRequests,
    benchmark: q8KernelBenchmarkSchema,
  }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['artifact', 'native-exports', 'worker', 'standalone']) }).strict(),
]);
export const q8DiagnosticNotificationSchema = z.object({
  kind: z.literal('naidan-q8-kernel-progress'),
  progress: q8KernelBenchmarkProgressSchema,
}).strict();
export type Q8DiagnosticWorkerRequest = z.infer<typeof q8DiagnosticWorkerRequestSchema>;
export type Q8DiagnosticWorkerResult = z.infer<typeof q8DiagnosticWorkerResultSchema>;
export interface Q8DiagnosticWorkerApi {
  run({ request }: { request: Q8DiagnosticWorkerRequest }): Promise<Q8DiagnosticWorkerResult>;
}
export interface Q8DiagnosticClient {
  run({ signal, timeoutMs, onProgress }: {
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onProgress: ({ progress }: { progress: z.infer<typeof q8KernelBenchmarkProgressSchema> }) => void,
  }): Promise<Q8DiagnosticWorkerResult>;
  dispose(): void;
}

export const TEST_ONLY = {
};
