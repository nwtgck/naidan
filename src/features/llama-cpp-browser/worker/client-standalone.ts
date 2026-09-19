import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import type { LlamaCppWorkerClient } from './types';
export function createLlamaCppWorkerClient(): LlamaCppWorkerClient {
  const unavailable = async (): Promise<never> => {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  };
  return { listModels: unavailable, importModel: unavailable, removeModel: unavailable, generate: unavailable, dispose() {} };
}
export const TEST_ONLY = {
};
