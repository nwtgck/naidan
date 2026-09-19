import type { EngineState, GenerateInput, LocalModel, RuntimeOptions } from './types';

export interface LlamaCppBrowserService {
  getState(): EngineState;
  getOptions(): RuntimeOptions;
  setOptions({ options }: { options: RuntimeOptions }): void;
  subscribe({ listener }: { listener: ({ state }: { state: EngineState }) => void }): () => void;
  subscribeModelList({ listener }: { listener: () => void }): () => void;
  listModels({ signal }: { signal: AbortSignal | undefined }): Promise<LocalModel[]>;
  importModel({ file, signal }: { file: File, signal: AbortSignal | undefined }): Promise<void>;
  removeModel({ id, signal }: { id: string, signal: AbortSignal | undefined }): Promise<void>;
  generate({ input, onChunk, signal }: {
    input: Omit<GenerateInput, 'options'>, onChunk: ({ chunk }: { chunk: string }) => void, signal: AbortSignal | undefined,
  }): Promise<void>;
  cancel(): void;
  release(): void;
}
export const TEST_ONLY = {
};
