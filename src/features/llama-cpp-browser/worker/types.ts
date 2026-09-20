import type { DeletionPlan, DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { z } from 'zod';
import { generateInputSchema } from '@/features/llama-cpp-browser/types';
import type { WorkerProxy } from '@/utils/worker-transport';
import type { ModelDirectoryInput, GenerateInput, GenerationResult, LocalModel, Progress } from '@/features/llama-cpp-browser/types';

export const workerGenerateInputSchema = generateInputSchema.extend({ assetBaseURL: z.url() }).strict();
export type WorkerGenerateInput = z.infer<typeof workerGenerateInputSchema>;

export const workerGenerateCallSchema = workerGenerateInputSchema.extend({ generationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export type WorkerGenerateCall = z.infer<typeof workerGenerateCallSchema>;

export interface LlamaCppWorkerApi {
  cancelGeneration({ generationId }: { generationId: number }): Promise<void>;
  listModels(): Promise<LocalModel[]>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  importModel(request: { file: File }, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>): Promise<LocalModel>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method with a top-level callback.
  importDirectory(request: { directory: ModelDirectoryInput, generationId: number }, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>): Promise<LocalModel>;
  removeModel({ plan }: { plan: DeletionPlan }): Promise<DeletionResult>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  generate(request: WorkerGenerateCall, onChunk: WorkerProxy<({ text }: { text: string }) => void>, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>, onDiagnostic?: WorkerProxy<({ diagnostic }: { diagnostic: Diagnostic }) => void>): Promise<GenerationResult>;
}
export interface LlamaCppWorkerClient {
  canReuse(): boolean;
  listModels({ signal }: { signal: AbortSignal | undefined }): Promise<LocalModel[]>;
  importModel({ file, onProgress, signal }: { file: File, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<LocalModel>;
  importDirectory({ directory, onProgress, signal }: { directory: ModelDirectoryInput, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<LocalModel>;
  removeModel({ plan, signal }: { plan: DeletionPlan, signal: AbortSignal | undefined }): Promise<DeletionResult>;
  generate({ request, onChunk, onProgress, signal }: { request: GenerateInput, onChunk: ({ chunk }: { chunk: string }) => void, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<GenerationResult>;
  dispose(): void;
}
export const TEST_ONLY = {
};
