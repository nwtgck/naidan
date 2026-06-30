
import { createHighlightWorkerClient } from '@/features/highlight/worker/client';
import type { HighlightWorkerClient } from './types';

let sharedHighlightWorkerClientPromise: Promise<HighlightWorkerClient> | undefined;
let sharedHighlightWorkerClientRefCount = 0;

export async function acquireSharedHighlightWorkerClient(): Promise<HighlightWorkerClient> {
  sharedHighlightWorkerClientRefCount += 1;
  sharedHighlightWorkerClientPromise ??= createHighlightWorkerClient();
  return sharedHighlightWorkerClientPromise;
}

export async function releaseSharedHighlightWorkerClient(): Promise<void> {
  sharedHighlightWorkerClientRefCount = Math.max(0, sharedHighlightWorkerClientRefCount - 1);

  if (sharedHighlightWorkerClientRefCount > 0 || !sharedHighlightWorkerClientPromise) {
    return;
  }

  const clientPromise = sharedHighlightWorkerClientPromise;
  sharedHighlightWorkerClientPromise = undefined;
  const client = await clientPromise;
  await client.dispose();
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
