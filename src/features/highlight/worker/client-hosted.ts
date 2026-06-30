import * as Comlink from 'comlink';

import { createHighlightWorker } from './impl';
import {
  highlightResponseSchema,
  type HighlightWorkerClient,
  type IHighlightWorker,
} from './types';

function createMainThreadFallbackClient(): HighlightWorkerClient {
  const worker = createHighlightWorker();

  return {
    async highlight({ request }) {
      return highlightResponseSchema.parse(await worker.highlight({ request }));
    },
    async dispose() {
    },
  };
}

export async function createHighlightWorkerClient(): Promise<HighlightWorkerClient> {
  if (typeof Worker === 'undefined') {
    return createMainThreadFallbackClient();
  }

  const worker = new Worker(
    new URL('./entry.ts', import.meta.url),
    {
      type: 'module',
      name: 'naidan-highlight-worker',
    },
  );
  const remote = Comlink.wrap<IHighlightWorker>(worker);

  return {
    async highlight({ request }) {
      return highlightResponseSchema.parse(await remote.highlight({ request }));
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
