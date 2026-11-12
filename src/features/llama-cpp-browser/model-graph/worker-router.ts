import type { WorkerPrepareInput, WorkerGenerateInput } from '@/features/llama-cpp-browser/worker/types';
import type { Progress, GenerationCallback, GenerationResult } from '@/features/llama-cpp-browser/types';
import type { Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { releaseSession } from '@/features/llama-cpp-browser/worker/session';
import { prepareRegisteredGraph, releaseRegisteredGraph } from './session';
import { generateWithRegisteredGraph as generateGraph } from './generation';
export { releaseRegisteredGraph };

/** A trap or incomplete destruction invalidates the shared module, not merely
 * the current graph. Keep a bad heap out of subsequent native model requests. */
async function retireFailure({ error }: { error: unknown }): Promise<void> {
  let discardRuntime = error instanceof WebAssembly.RuntimeError;
  try {
    await releaseRegisteredGraph();
  } catch {
    discardRuntime = true;
  }
  if (discardRuntime) {
    try {
      await releaseSession({ releaseRuntime: true });
    } catch { /* The original request error remains primary. */ }
  }
}

export async function prepare({ request, signal, onProgress, purpose }: {
  request: WorkerPrepareInput, signal: AbortSignal | undefined,
  onProgress: ({ progress }: { progress: Progress }) => void, purpose: 'text' | 'vision' | 'audio' | 'live',
}): Promise<boolean> {
  try {
    return await prepareRegisteredGraph({ request, signal, onProgress, purpose }) !== undefined;
  } catch (error) {
    await retireFailure({ error });
    throw error;
  }
}

export async function generateWithRegisteredGraph({ request, signal, onEvent, onProgress, onSummary, native }: {
  request: WorkerGenerateInput, signal: AbortSignal | undefined, onEvent: GenerationCallback,
  onProgress: ({ progress }: { progress: Progress }) => void,
  onSummary: (({ diagnostic }: { diagnostic: Diagnostic }) => void) | undefined,
  native: () => Promise<GenerationResult>,
}): Promise<GenerationResult> {
  try {
    return await generateGraph({ request, signal, onEvent, onProgress, onSummary, native });
  } catch (error) {
    await retireFailure({ error });
    throw error;
  }
}

export const TEST_ONLY = {
};
