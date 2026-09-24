import type { AudioPreviewDelivery } from '@/features/audio-generation/preview-requests';
import { audioGenerationInputSchema, type AudioPreviewEvent, type AudioGenerationInput, type AudioGenerationResult } from '@/features/audio-generation/types';
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

export const workerAudioInputSchema = audioGenerationInputSchema.extend({ options: runtimeOptionsSchema.extend({ profile: profileSchema }), assetBaseURL: z.url().optional() }).strict();
export type WorkerAudioInput = z.infer<typeof workerAudioInputSchema>;
export const workerAudioCallSchema = workerAudioInputSchema.extend({ generationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export type WorkerAudioCall = z.infer<typeof workerAudioCallSchema>;

export interface LlamaCppWorkerApi {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  generateAudio(request: WorkerAudioCall, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>, onDiagnostic: WorkerProxy<({ diagnostic }: { diagnostic: Diagnostic }) => void>, onPreview?: WorkerProxy<({ result, requestVersion }: AudioPreviewEvent) => Promise<void>>): Promise<AudioGenerationResult>;
  probeProfiles(): Promise<ProfileCapabilities>;
  verifyStorage({ probeId }: { probeId: string }): Promise<boolean>;
  release(): Promise<void>;
  cancelGeneration({ generationId }: { generationId: number }): Promise<void>;
  finishAudioGeneration({ generationId }: { generationId: number }): Promise<void>;
  requestAudioPreview({ generationId, requestVersion }: { generationId: number, requestVersion: number }): Promise<void>;
  listModels(): Promise<LocalModel[]>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  importModel(request: { file: File, generationId: number }, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>): Promise<LocalModel>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method with a top-level callback.
  importDirectory(request: { directory: ModelDirectoryInput, generationId: number }, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>): Promise<LocalModel>;
  removeModel({ plan }: { plan: DeletionPlan }): Promise<DeletionResult>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  generate(request: WorkerGenerateCall, onEvent: WorkerProxy<({ event }: { event: GenerationEvent }) => Promise<void>>, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>, onDiagnostic?: WorkerProxy<({ diagnostic }: { diagnostic: Diagnostic }) => void>): Promise<GenerationResult>;
}
export interface LlamaCppWorkerClient {
  generateAudio({ request, onProgress, cancellationSignal, completionSignal, preview }: { request: AudioGenerationInput, onProgress: ({ progress }: { progress: Progress }) => void, cancellationSignal: AbortSignal | undefined, completionSignal?: AbortSignal, preview?: AudioPreviewDelivery }): Promise<AudioGenerationResult>;
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
