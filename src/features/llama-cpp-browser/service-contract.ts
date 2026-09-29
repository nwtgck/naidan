import type { AudioPreviewDelivery } from '@/features/audio-generation/preview-requests';
import type { AudioGenerationInput, AudioGenerationResult } from '@/features/audio-generation/types';
import type { ProfileCapabilities, ProfileState } from './runtime/profile-capabilities';
import type { DeletionPlan, DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import type { ModelDirectoryInput, EngineState, GenerateInput, GenerationResult, GenerationCallback, LocalModel, RuntimeOptions } from './types';

export interface LlamaCppBrowserService {
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
  runGenerationOperation({ signal, operation }: {
    signal: AbortSignal | undefined,
    operation: ({ scope }: { scope: LlamaCppGenerationScope }) => Promise<void>,
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
export const TEST_ONLY = {
};
