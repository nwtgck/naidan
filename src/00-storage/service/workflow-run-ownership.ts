import { idToRaw, type WorkflowRunId } from '@/01-models/ids';

export type WorkflowRunLease = { release: () => Promise<void> };

/** Keep only a per-run lock across execution. Holding the global storage lock
 * here would block unrelated settings, sync, and file operations for the run.
 * Probes and recovery use the same exclusive lock without waiting or stealing.
 */
export async function acquireWorkflowRunLease({ locks, id }: { locks: Pick<LockManager, 'request'>, id: WorkflowRunId }): Promise<WorkflowRunLease | undefined> {
  const raw = idToRaw({ id });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    throw new Error('Invalid Workflow run ID.');
  }
  const acquired = Promise.withResolvers<WorkflowRunLease | undefined>();
  const held = Promise.withResolvers<void>();
  const completion: Promise<void> = locks.request(`naidan-workflow-run-owner:${raw}`, { mode: 'exclusive', ifAvailable: true }, lock => {
    if (!lock) {
      acquired.resolve(undefined);
      return;
    }
    acquired.resolve({
      async release() {
        held.resolve();
        // Await the request, not just the hold promise: the manager has released
        // the lock only when the outer request completes.
        await completion;
      },
    });
    return held.promise;
  });
  void completion.catch(acquired.reject);
  return acquired.promise;
}

export const TEST_ONLY = {
};
