import { FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME } from '@/constants';
import { wrapWorkerRemote } from '@/utils/worker-transport';
import type { WeshMount } from '@/features/wesh/types';
import { createWeshWorkerClient } from './client-runtime';
import type { IWeshWorker, WeshWorkerClient } from './types';

export function createFileProtocolCompatibleWeshWorkerClient({
  rootHandle,
  mounts,
  user,
  initialEnv,
  initialCwd,
  onRuntimeFailure,
}: {
  rootHandle: FileSystemDirectoryHandle | 'readonly',
  mounts: WeshMount[],
  user: string,
  initialEnv: Record<string, string>,
  initialCwd?: string | undefined,
  onRuntimeFailure?: (() => void) | undefined,
}): WeshWorkerClient {
  return createWeshWorkerClient({
    rootHandle,
    mounts,
    user,
    initialEnv,
    initialCwd,
    onRuntimeFailure,
    async createSession({ signal }) {
      signal.throwIfAborted();
      const worker = new Worker(
        new URL('./entry.ts', import.meta.url),
        { type: 'module', name: FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME },
      );
      try {
        return { worker, remote: wrapWorkerRemote<IWeshWorker>({ endpoint: worker }) };
      } catch (error) {
        worker.terminate();
        throw error;
      }
    },
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
