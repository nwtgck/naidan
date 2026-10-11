import { loadedModelDescriptorSchema } from '@/features/llama-cpp-browser/loaded-model-descriptor';
import { z } from 'zod';
import { nativeFlashAttentionSchema } from '@/features/llama-cpp-browser/debug-log';
import { memoryDiagnosticSchema } from '@/features/llama-cpp-browser/memory-diagnostics';

// These are observations of capacity/API requests and allocation log attempts,
// never an estimate of current physical memory or device residency.
export const memoryDiagnosticsSchema = z.object({
  samples: z.array(memoryDiagnosticSchema).max(128),
  droppedSamples: z.number().int().nonnegative(),
  nativeAllocations: z.array(z.object({
    observedMs: z.number().finite().nonnegative(),
    nativeMetric: z.enum(['model_buffer_mib', 'kv_buffer_mib', 'recurrent_buffer_mib', 'compute_buffer_mib']),
    nativeBackend: z.enum(['CPU', 'CPU_Mapped', 'WebGPU']),
    nativeValue: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict()).max(128),
  droppedNativeAllocations: z.number().int().nonnegative(),
  nativeSettings: z.array(z.union([z.object({
    observedMs: z.number().finite().nonnegative(),
    loadedModelDescriptor: loadedModelDescriptorSchema,
  }).strict(), z.object({
    observedMs: z.number().finite().nonnegative(),
    nativeMetric: z.enum(['n_ctx', 'n_ctx_seq', 'n_batch', 'n_ubatch', 'n_seq_max', 'graph_nodes', 'graph_splits']),
    nativeValue: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    batchTokens: z.number().int().positive().max(2147483647).optional(),
    nativeSingleTokenValue: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict(), z.object({
    observedMs: z.number().finite().nonnegative(),
    contextAttempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    nativeFlashAttention: nativeFlashAttentionSchema,
  }).strict(), z.object({
    observedMs: z.number().finite().nonnegative(),
    contextAttempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    contextEvent: z.enum(['context-start', 'context-retry', 'context-ready']),
    contextTokens: z.number().int().positive().optional(),
    batchTokens: z.number().int().positive().optional(),
  }).strict()])).max(128),
  droppedNativeSettings: z.number().int().nonnegative(),
}).strict();
export type MemoryDiagnostics = z.infer<typeof memoryDiagnosticsSchema>;
export const TEST_ONLY = {
};
