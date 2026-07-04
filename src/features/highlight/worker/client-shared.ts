import { createHighlightWorkerClient } from '@/features/highlight/worker/client';
import type { HighlightWorkerClient } from './types';

export interface SharedHighlightWorkerClientLease {
  client: HighlightWorkerClient;
  release(): Promise<void>;
}

interface SharedHighlightWorkerClientState {
  clientPromise: Promise<HighlightWorkerClient>;
  leaseCount: number;
}

let sharedHighlightWorkerClientState: SharedHighlightWorkerClientState | undefined;

function createSharedHighlightWorkerClientState(): SharedHighlightWorkerClientState {
  return {
    clientPromise: (async () => await createHighlightWorkerClient())(),
    leaseCount: 0,
  };
}

export async function acquireSharedHighlightWorkerClientLease(): Promise<SharedHighlightWorkerClientLease> {
  const state = sharedHighlightWorkerClientState ?? createSharedHighlightWorkerClientState();
  sharedHighlightWorkerClientState = state;
  state.leaseCount += 1;

  let client: HighlightWorkerClient;
  try {
    client = await state.clientPromise;
  } catch (error) {
    state.leaseCount = Math.max(0, state.leaseCount - 1);
    if (sharedHighlightWorkerClientState === state) {
      sharedHighlightWorkerClientState = undefined;
    }
    throw error;
  }

  let released = false;

  return {
    client,
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;
      state.leaseCount = Math.max(0, state.leaseCount - 1);

      if (
        state.leaseCount > 0
        || sharedHighlightWorkerClientState !== state
      ) {
        return;
      }

      sharedHighlightWorkerClientState = undefined;
      await client.dispose();
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
