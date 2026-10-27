import { isModelSourceSegment } from '@/01-models/llama-cpp-browser-model-id';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

/** Reserve readable pending names across tabs without persisting ownership.
 * This lock protects names only; file I/O uses the existing mutation lock. */
export async function reserveLocalRepositoryName({ rootName, signal }: {
  rootName: string, signal: AbortSignal | undefined,
}): Promise<{ rootName: string, release(): Promise<void> }> {
  if (!isModelSourceSegment({ name: rootName }) || rootName.startsWith('.')) {
    throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
  if (!navigator.locks?.request) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  for (let index = 1; ; index++) {
    signal?.throwIfAborted();
    const suffix = index === 1 ? '' : `-${index}`;
    const characters = Array.from(rootName);
    while (new TextEncoder().encode(characters.join('') + suffix).length > 255) {
      characters.pop();
    }
    const candidate = characters.join('') + suffix;
    const acquired = Promise.withResolvers<boolean>();
    const lifetime = Promise.withResolvers<void>();
    const held = navigator.locks.request(`naidan-llama-cpp-local-repository:${candidate}`, { ifAvailable: true }, lock => {
      acquired.resolve(lock !== null);
      return lock === null ? undefined : lifetime.promise;
    });
    // Acquisition failure must settle the admission Promise as well. The held
    // Promise lasts until retirement and must not be awaited during admission.
    void held.catch(acquired.reject);
    if (!await acquired.promise) {
      await held;
      continue;
    }
    if (signal?.aborted) {
      lifetime.resolve();
      await held;
      signal.throwIfAborted();
    }
    return {
      rootName: candidate,
      release: async () => {
        lifetime.resolve();
        await held;
      },
    };
  }
}

export const TEST_ONLY = {
};
