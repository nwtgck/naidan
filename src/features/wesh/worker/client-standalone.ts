import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/wesh';
import { createStandaloneWorkerSession } from '@/features/file-protocol-standalone/worker/standalone-worker-session';
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
    createSession: ({ signal }) => createStandaloneWorkerSession<IWeshWorker>({
      createWorker: () => createStandaloneWorker({ signal }),
    }),
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
