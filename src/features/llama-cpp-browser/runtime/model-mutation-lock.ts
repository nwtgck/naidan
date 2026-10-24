import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

export const modelMutationLockName = 'naidan-llama-cpp-browser-model-mutation';

export async function withModelMutationLock<T>({ operation, signal }: { operation: () => Promise<T>, signal?: AbortSignal }): Promise<T> {
  if (!navigator.locks) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  return navigator.locks.request(modelMutationLockName, { mode: 'exclusive', signal }, operation);
}

export const TEST_ONLY = {
};
