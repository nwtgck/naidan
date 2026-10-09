import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import type { AudioPreviewDelivery } from '@/features/audio-generation/preview-requests';
import type { AudioGenerationInput, AudioGenerationResult } from '@/features/audio-generation/types';
import type { ProfileCapabilities, ProfileState } from './runtime/profile-capabilities';
import type { DeletionPlan, DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import type { ModelDirectoryInput, EngineState, GenerateInput, GenerationResult, GenerationCallback, LocalModel, RuntimeOptions, Progress } from './types';

export interface LlamaCppBrowserService {
  /** Best-effort preparation: never queues behind an existing operation. */
  prepareModel({ model, signal, onProgress }: { model: string, signal: AbortSignal | undefined, onProgress?: ({ progress }: { progress: Progress }) => void }): Promise<'ready' | 'skipped-busy'>;
  generateAudio({ input, cancellationSignal, completionSignal, preview }: { input: Omit<AudioGenerationInput, 'options'>, cancellationSignal: AbortSignal | undefined, completionSignal?: AbortSignal, preview?: AudioPreviewDelivery }): Promise<AudioGenerationResult>;
  getProfileState(): ProfileState;
  subscribeProfiles({ listener }: { listener: ({ state }: { state: ProfileState }) => void }): () => void;
  probeProfiles({ signal }: { signal: AbortSignal | undefined }): Promise<ProfileCapabilities>;
  getState(): EngineState;
  getOptions(): RuntimeOptions;
  setOptions({ options }: { options: RuntimeOptions }): void;
  subscribe({ listener }: { listener: ({ state }: { state: EngineState }) => void }): () => void;
  subscribeModelList({ listener }: { listener: () => void }): () => void;
  listModels({ signal }: { signal: AbortSignal | undefined }): Promise<LocalModel[]>;
  importModel({ file, signal }: { file: File, signal: AbortSignal | undefined }): Promise<void>;
  importDirectory({ directory, signal }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined }): Promise<void>;
  removeModel({ plan, signal }: { plan: DeletionPlan, signal: AbortSignal | undefined }): Promise<DeletionResult>;
  generate({ input, onEvent, signal }: {
    input: Omit<GenerateInput, 'options'>, onEvent: GenerationCallback, signal: AbortSignal | undefined,
  }): Promise<GenerationResult>;
  runGenerationOperation({ signal, operation, onProgress }: {
    signal: AbortSignal | undefined,
    onProgress?: ({ progress }: { progress: Progress }) => void,
    operation: ({ scope }: { scope: LlamaCppGenerationScope }) => Promise<void>,
  }): Promise<void>;
  runPerformanceOperation({ options, signal, operation }: {
    options: RuntimeOptions,
    signal: AbortSignal | undefined,
    operation: ({ scope }: { scope: LlamaCppPerformanceScope }) => Promise<void>,
  }): Promise<void>;
  restartRuntime({ signal }: { signal: AbortSignal | undefined }): Promise<ProfileCapabilities>;
  cancel(): void;
  release(): void;
}
/** A single lane owner, including tool waits outside the native runtime. */
export interface LlamaCppGenerationScope {
  readonly signal: AbortSignal;
  generate: LlamaCppBrowserService['generate'];
}
/** One model's measured trials; shares the ordinary Worker and native loop. */
export interface LlamaCppPerformanceScope {
  readonly signal: AbortSignal;
  readonly options: RuntimeOptions;
  generate({ input, sequence, observation, onEvent, onSummary, onProgress, signal }: {
    input: Omit<GenerateInput, 'options'>,
    sequence: 'fresh' | 'continue',
    observation?: 'placement',
    onEvent: GenerationCallback,
    onSummary: ({ diagnostic }: { diagnostic: Diagnostic }) => void,
    onProgress?: ({ progress }: { progress: Progress }) => void,
    signal: AbortSignal,
  }): Promise<GenerationResult>;
}
export const TEST_ONLY = {
};
