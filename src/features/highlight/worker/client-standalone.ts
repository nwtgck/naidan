import * as Comlink from 'comlink';

import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';
import {
  highlightResponseSchema,
  type HighlightWorkerClient,
} from './types';

export async function createHighlightWorkerClient(): Promise<HighlightWorkerClient> {
  const worker = await createFileProtocolStandaloneWorkerHub();
  const remote = Comlink.wrap<IWorkerHub>(worker);
  const highlight = await remote.highlight;

  return {
    async highlight({ request }) {
      return highlightResponseSchema.parse(await highlight.highlight({ request }));
    },
    async dispose() {
      try {
        await remote[Comlink.releaseProxy]();
      } finally {
        worker.terminate();
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
