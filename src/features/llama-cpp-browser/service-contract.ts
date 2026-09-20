import type { DeletionPlan, DeletionResult } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import type { ModelDirectoryInput, EngineState, GenerateInput, GenerationResult, LocalModel, RuntimeOptions } from './types';

export interface LlamaCppBrowserService {
  getState(): EngineState;
  getOptions(): RuntimeOptions;
  setOptions({ options }: { options: RuntimeOptions }): void;
  subscribe({ listener }: { listener: ({ state }: { state: EngineState }) => void }): () => void;
  subscribeModelList({ listener }: { listener: () => void }): () => void;
  listModels({ signal }: { signal: AbortSignal | undefined }): Promise<LocalModel[]>;
  importModel({ file, signal }: { file: File, signal: AbortSignal | undefined }): Promise<void>;
  importDirectory({ directory, signal }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined }): Promise<void>;
  removeModel({ plan, signal }: { plan: DeletionPlan, signal: AbortSignal | undefined }): Promise<DeletionResult>;
  generate({ input, onChunk, signal }: {
    onResult?: ({ result, signal }: { result: GenerationResult, signal: AbortSignal }) => Promise<Omit<GenerateInput, 'options'> | undefined>,
    input: Omit<GenerateInput, 'options'>, onChunk: ({ chunk }: { chunk: string }) => void, signal: AbortSignal | undefined,
  }): Promise<void>;
  cancel(): void;
  release(): void;
}
export const TEST_ONLY = {
};
