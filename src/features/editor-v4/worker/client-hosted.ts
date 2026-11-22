import { releaseWorkerRemote, wrapWorkerRemote } from '@/utils/worker-transport';
import { createEditorSearchFallback, wrapEditorSearchClient } from './client-shared';
import type { EditorSearchClient, EditorSearchWorker } from './types';

export async function createEditorSearchClient(): Promise<EditorSearchClient> {
  if (typeof Worker === 'undefined') {
    return createEditorSearchFallback();
  }
  try {
    const worker = new Worker(new URL('./entry.ts', import.meta.url), { type: 'module', name: 'naidan-editor-v4-worker' });
    const remote = wrapWorkerRemote<EditorSearchWorker>({ endpoint: worker });
    return wrapEditorSearchClient({
      api: remote,
      async dispose() {
        try {
          releaseWorkerRemote({ remote });
        } finally {
          worker.terminate();
        }
      },
    });
  } catch {
    return createEditorSearchFallback();
  }
}

export const TEST_ONLY = {
};
