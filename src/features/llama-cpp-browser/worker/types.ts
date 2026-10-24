import { resolvedModelSchema } from '@/features/llama-cpp-browser/runtime/resolved-model-schema';
import type { ResolvedModel } from '@/features/llama-cpp-browser/runtime/model-directory';
import type { MemoryDiagnostics } from '@/features/llama-cpp-browser/performance/memory-schema';
import type { AudioPreviewDelivery } from '@/features/audio-generation/preview-requests';
import { audioGenerationInputSchema, type AudioPreviewEvent, type AudioGenerationInput, type AudioGenerationResult } from '@/features/audio-generation/types';
import type { DeletionPlan, DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { z } from 'zod';
import type { ProfileCapabilities } from '@/features/llama-cpp-browser/runtime/profile-capabilities';
import { generateInputSchema, profileSchema, runtimeOptionsSchema } from '@/features/llama-cpp-browser/types';
import type { WorkerProxy, WorkerCapability } from '@/utils/worker-transport';
import type { ModelDirectoryInput, GenerateInput, GenerationResult, GenerationCallback, GenerationEvent, LocalModel, Progress } from '@/features/llama-cpp-browser/types';

const workerGenerateBaseSchema = generateInputSchema.extend({ options: runtimeOptionsSchema.extend({ profile: profileSchema }), measurement: z.object({ sequence: z.enum(['fresh', 'continue']), observation: z.literal('placement').optional() }).strict().optional(), assetBaseURL: z.url().optional(), resolvedModel: resolvedModelSchema }).strict();
export const workerGenerateInputSchema = workerGenerateBaseSchema.refine(request => request.modelId === request.resolvedModel.modelId, { path: ['resolvedModel', 'modelId'], error: 'Resolved model does not match the requested modelId' });
export type WorkerGenerateInput = z.infer<typeof workerGenerateInputSchema>;

const workerPrepareBaseSchema = workerGenerateBaseSchema.pick({ modelId: true, options: true, debug: true, assetBaseURL: true, resolvedModel: true }).strict();
export const workerPrepareInputSchema = workerPrepareBaseSchema.refine(request => request.modelId === request.resolvedModel.modelId, { path: ['resolvedModel', 'modelId'], error: 'Resolved model does not match the requested modelId' });
export type WorkerPrepareInput = z.infer<typeof workerPrepareInputSchema>;
export const workerPrepareCallSchema = workerPrepareBaseSchema.extend({ generationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().refine(request => request.modelId === request.resolvedModel.modelId, { path: ['resolvedModel', 'modelId'], error: 'Resolved model does not match the requested modelId' });
export type WorkerPrepareCall = z.infer<typeof workerPrepareCallSchema>;

export const workerGenerateCallSchema = workerGenerateBaseSchema.extend({ generationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().refine(request => request.modelId === request.resolvedModel.modelId, { path: ['resolvedModel', 'modelId'], error: 'Resolved model does not match the requested modelId' });
export type WorkerGenerateCall = z.infer<typeof workerGenerateCallSchema>;

const workerAudioBaseSchema = audioGenerationInputSchema.extend({ options: runtimeOptionsSchema.extend({ profile: profileSchema }), assetBaseURL: z.url().optional(), resolvedModel: resolvedModelSchema }).strict();
export const workerAudioInputSchema = workerAudioBaseSchema.refine(request => request.modelId === request.resolvedModel.modelId, { path: ['resolvedModel', 'modelId'], error: 'Resolved model does not match the requested modelId' });
export type WorkerAudioInput = z.infer<typeof workerAudioInputSchema>;
export const workerAudioCallSchema = workerAudioBaseSchema.extend({ generationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().refine(request => request.modelId === request.resolvedModel.modelId, { path: ['resolvedModel', 'modelId'], error: 'Resolved model does not match the requested modelId' });
export type WorkerAudioCall = z.infer<typeof workerAudioCallSchema>;

export type AcceptedGenerateInput = GenerateInput & { resolvedModel: ResolvedModel };
export type AcceptedAudioInput = AudioGenerationInput & { resolvedModel: ResolvedModel };

export interface LlamaCppWorkerApi {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method with a top-level progress proxy.
  prepareModel(request: WorkerCapability<WorkerPrepareCall, 'file-system-handle-clone'>, onProgress: WorkerProxy<(progress: Progress) => void>): Promise<void>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  generateAudio(request: WorkerCapability<WorkerAudioCall, 'file-system-handle-clone'>, onProgress: WorkerProxy<(progress: Progress) => void>, onDiagnostic: WorkerProxy<({ diagnostic }: { diagnostic: Diagnostic }) => void>, onPreview?: WorkerProxy<(event: AudioPreviewEvent) => Promise<void>>): Promise<AudioGenerationResult>;
  probeProfiles(): Promise<ProfileCapabilities>;
  verifyStorage({ probeId }: { probeId: string }): Promise<boolean>;
  release(): Promise<void>;
  cancelGeneration({ generationId }: { generationId: number }): Promise<void>;
  finishAudioGeneration({ generationId }: { generationId: number }): Promise<void>;
  requestAudioPreview({ generationId, requestVersion }: { generationId: number, requestVersion: number }): Promise<void>;
  listModelEntries(): Promise<LocalModel[]>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  importModel(request: { file: File, generationId: number }, onProgress: WorkerProxy<(progress: Progress) => void>): Promise<LocalModel>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method with a top-level callback.
  importDirectory(request: { directory: ModelDirectoryInput, generationId: number }, onProgress: WorkerProxy<(progress: Progress) => void>): Promise<LocalModel>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- The Worker RPC capability marker wraps the complete wire request.
  removeModel(request: WorkerCapability<{ plan: DeletionPlan }, 'file-system-handle-clone'>): Promise<DeletionResult>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  generate(request: WorkerCapability<WorkerGenerateCall, 'file-system-handle-clone'>, onEvent: WorkerProxy<({ event }: { event: GenerationEvent }) => Promise<void>>, onProgress: WorkerProxy<(progress: Progress) => void>, onDiagnostic?: WorkerProxy<({ diagnostic }: { diagnostic: Diagnostic }) => void>, onSummary?: WorkerProxy<({ diagnostic }: { diagnostic: Diagnostic }) => void>): Promise<GenerationResult>;
}
export interface LlamaCppWorkerClient {
  prepareModel({ request, onProgress, signal }: { request: WorkerPrepareInput, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<void>;
  generateAudio({ request, onProgress, cancellationSignal, completionSignal, preview }: { request: AcceptedAudioInput, onProgress: ({ progress }: { progress: Progress }) => void, cancellationSignal: AbortSignal | undefined, completionSignal?: AbortSignal, preview?: AudioPreviewDelivery }): Promise<AudioGenerationResult>;
  subscribeDisposed({ listener }: { listener: () => void }): () => void;
  probeProfiles({ signal }: { signal: AbortSignal | undefined }): Promise<ProfileCapabilities>;
  canReuse(): boolean;
  releaseRuntime({ signal }: { signal: AbortSignal | undefined }): Promise<void>;
  listModelEntries({ signal }: { signal: AbortSignal | undefined }): Promise<LocalModel[]>;
  importModel({ file, onProgress, signal }: { file: File, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<LocalModel>;
  importDirectory({ directory, onProgress, signal }: { directory: ModelDirectoryInput, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<LocalModel>;
  removeModel({ plan, signal }: { plan: DeletionPlan, signal: AbortSignal | undefined }): Promise<DeletionResult>;
  generate({ request, onEvent, onProgress, signal, onSummary, onMemoryDiagnostics }: { request: AcceptedGenerateInput & Pick<WorkerGenerateInput, 'measurement'>, onEvent: GenerationCallback, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined, onSummary?: ({ diagnostic }: { diagnostic: Diagnostic }) => void, onMemoryDiagnostics?: ({ memory }: { memory: MemoryDiagnostics }) => void }): Promise<GenerationResult>;
  dispose(): void | Promise<void>;
}
export const TEST_ONLY = {
};
