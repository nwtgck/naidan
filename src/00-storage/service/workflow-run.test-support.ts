import type { WorkflowRunId, WorkflowId } from '@/01-models/ids';
import type { WorkflowDefinition } from '@/01-models/workflow';
import { TEST_ONLY as runStoreTest } from './workflow-run';
import { acquireWorkflowRunLease } from './workflow-run-ownership';
import type { createWorkflowTestLocks } from './workflow-locks.test-support';

/** Each caller models a different store/tab, sharing filesystem and lock queue. */
export function createWorkflowRunTestStore({ directory, locks, wait }: {
  directory: FileSystemDirectoryHandle,
  locks: ReturnType<typeof createWorkflowTestLocks>['locks'],
  wait: Promise<void> | undefined,
}) {
  const ids = new Set<WorkflowRunId>();
  const store = runStoreTest.createStore({
    access: {
      acquireRun: ({ id }) => acquireWorkflowRunLease({ locks, id }),
      directory: async () => directory,
      lock: ({ operation }) => locks.request('test-workflow-storage', async () => {
        await wait;
        return operation();
      }),
    },
  });
  return {
    ...store,
    async create({ workflowId, definition }: { workflowId: WorkflowId | undefined, definition: WorkflowDefinition }) {
      const result = await store.create({ workflowId, definition });
      ids.add(result.record.id);
      return result;
    },
    async [Symbol.asyncDispose]() {
      for (const id of ids) {
        await store.release({ id });
      }
    },
  };
}

export const TEST_ONLY = {
};
