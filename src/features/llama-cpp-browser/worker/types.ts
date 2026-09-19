import { z } from 'zod';
import { generateInputSchema } from '@/features/llama-cpp-browser/types';
import type { WorkerProxy } from '@/utils/worker-transport';
import type { GenerateInput, LocalModel, Progress } from '@/features/llama-cpp-browser/types';

export const workerGenerateInputSchema = generateInputSchema.extend({ assetBaseURL: z.url() }).strict();
export type WorkerGenerateInput = z.infer<typeof workerGenerateInputSchema>;

export interface LlamaCppWorkerApi {
  listModels(): Promise<LocalModel[]>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  importModel(request: { file: File }, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>): Promise<LocalModel>;
  removeModel({ id }: { id: string }): Promise<void>;
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Direct Comlink method; proxied callbacks must be top-level arguments.
  generate(request: WorkerGenerateInput, onChunk: WorkerProxy<({ text }: { text: string }) => void>, onProgress: WorkerProxy<({ phase, completed, total }: Progress) => void>): Promise<void>;
}
export interface LlamaCppWorkerClient {
  listModels({ signal }: { signal: AbortSignal | undefined }): Promise<LocalModel[]>;
  importModel({ file, onProgress, signal }: { file: File, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<LocalModel>;
  removeModel({ id, signal }: { id: string, signal: AbortSignal | undefined }): Promise<void>;
  generate({ request, onChunk, onProgress, signal }: { request: GenerateInput, onChunk: ({ chunk }: { chunk: string }) => void, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined }): Promise<void>;
  dispose(): void;
}
export const TEST_ONLY = {
};
