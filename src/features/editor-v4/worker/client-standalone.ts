import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/editor-v4';
import {
  createStandaloneWorkerSession,
  disposeStandaloneWorkerSession,
  STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
} from '@/features/file-protocol-standalone/worker/standalone-worker-session';
import { createEditorSearchFallback, wrapEditorSearchClient } from './client-shared';
import type { EditorSearchClient, EditorSearchWorker } from './types';

export async function createEditorSearchClient(): Promise<EditorSearchClient> {
  try {
    const session = await createStandaloneWorkerSession<EditorSearchWorker>({ createWorker: createStandaloneWorker });
    return wrapEditorSearchClient({
      api: session.remote,
      dispose: () => disposeStandaloneWorkerSession({
        session,
        beforeRelease: undefined,
        cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      }),
    });
  } catch {
    return createEditorSearchFallback();
  }
}

export const TEST_ONLY = {
};
