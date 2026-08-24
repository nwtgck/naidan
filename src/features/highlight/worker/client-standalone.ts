import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/highlight';
import {
  createStandaloneWorkerSession,
  disposeStandaloneWorkerSession,
  STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
} from '@/features/file-protocol-standalone/worker/standalone-worker-session';
import {
  highlightResponseSchema,
  type IHighlightWorker,
  type HighlightWorkerClient,
} from './types';

export async function createHighlightWorkerClient(): Promise<HighlightWorkerClient> {
  const session = await createStandaloneWorkerSession<IHighlightWorker>({ createWorker: createStandaloneWorker });
  const { remote } = session;

  return {
    async highlight({ request }) {
      return highlightResponseSchema.parse(await remote.highlight({ request }));
    },
    async dispose() {
      await disposeStandaloneWorkerSession({
        session,
        beforeRelease: undefined,
        cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
