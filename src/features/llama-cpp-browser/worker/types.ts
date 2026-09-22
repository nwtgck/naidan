import type { WorkerBlobImageHost } from '@/utils/worker-blob-image';
import type { WorkerBlobReadHost } from '@/utils/worker-blob-context';
import type { DeletionPlan, DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { z } from 'zod';
import type { ProfileCapabilities } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { generateInputSchema, profileSchema, runtimeOptionsSchema } from '@/features/llama-cpp-browser/types';
import type { WorkerProxy } from '@/utils/worker-transport';
import type { ModelDirectoryInput, GenerateInput, GenerationResult, GenerationCallback, GenerationEvent, LocalModel, Progress } from '@/features/llama-cpp-browser/types';

export const workerGenerateInputSchema = generateInputSchema.extend({ options: runtimeOptionsSchema.extend({ profile: profileSchema }), assetBaseURL: z.url().optional() }).strict();
export type WorkerGenerateInput = z.infer<typeof workerGenerateInputSchema>;

export const workerGenerateCallSchema = workerGenerateInputSchema.extend({ generationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export type WorkerGenerateCall = z.infer<typeof workerGenerateCallSchema>;

export interface LlamaCppWorkerApi {
  probeProfiles(): Promise<ProfileCapabilities>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Comlink reverse proxies must be independent top-level arguments.
  verifyStorage(request: { probeId: string }, blobReadHost?: WorkerProxy<WorkerBlobReadHost>): Promise<boolean>;
  release(): Promise<void>;
  cancelGeneration({ generationId }: { generationId: number }): Promise<void>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- The reverse proxy is the top-level Comlink argument.
  listModels(blobReadHost?: WorkerProxy<WorkerBlobReadHost>): Promise<LocalModel[]>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  importModel(request: { file: File, generationId: number }, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>, blobReadHost?: WorkerProxy<WorkerBlobReadHost>): Promise<LocalModel>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method with a top-level callback.
  importDirectory(request: { directory: ModelDirectoryInput, generationId: number }, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>, blobReadHost?: WorkerProxy<WorkerBlobReadHost>): Promise<LocalModel>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- The reverse proxy must remain outside the request object.
  removeModel(request: { plan: DeletionPlan }, blobReadHost?: WorkerProxy<WorkerBlobReadHost>): Promise<DeletionResult>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  generate(request: WorkerGenerateCall, onEvent: WorkerProxy<({ event }: { event: GenerationEvent }) => Promise<void>>, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>, onDiagnostic?: WorkerProxy<({ diagnostic }: { diagnostic: Diagnostic }) => void>, blobReadHost?: WorkerProxy<WorkerBlobReadHost>, imageDecodeHost?: WorkerProxy<WorkerBlobImageHost>): Promise<GenerationResult>;
}
export interface LlamaCppWorkerClient {
  subscribeDisposed({ listener }: { listener: () => void }): () => void;
  probeProfiles({ signal }: { signal: AbortSignal | undefined }): Promise<ProfileCapabilities>;
  canReuse(): boolean;
  listModels({ signal }: { signal: AbortSignal | undefined }): Promise<LocalModel[]>;
  importModel({ file, onProgress, signal }: { file: File, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<LocalModel>;
  importDirectory({ directory, onProgress, signal }: { directory: ModelDirectoryInput, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<LocalModel>;
  removeModel({ plan, signal }: { plan: DeletionPlan, signal: AbortSignal | undefined }): Promise<DeletionResult>;
  generate({ request, onEvent, onProgress, signal }: { request: GenerateInput, onEvent: GenerationCallback, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<GenerationResult>;
  dispose(): void;
}
export const TEST_ONLY = {
};
