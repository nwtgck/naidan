import type { ImageExecutionJob, PreparedImageExecution } from './types';

/** One immutable request, one physical job at a time. Handles from an earlier
 * image must not control a later job, even when both use the same engine. */
export function createImageExecutionPlan<Snapshot>({ snapshot, copySnapshot, start, reserve }: {
  snapshot: Snapshot,
  copySnapshot({ snapshot }: { snapshot: Snapshot }): Snapshot,
  start: PreparedImageExecution<Snapshot>['start'],
  reserve?: PreparedImageExecution<Snapshot>['reserve'],
}): PreparedImageExecution<Snapshot> {
  const captured = copySnapshot({ snapshot });
  let active: object | undefined;
  return {
    reserve,
    get snapshot() {
      return copySnapshot({ snapshot: captured });
    },
    start({ seed, signal, onProgress, onPreview }) {
      if (active) throw new Error('An image execution plan is already running');
      if (signal.aborted) return { result: Promise.resolve({ status: 'cancelled' }), cancel() {}, updatePreview: undefined };
      const token = {}; active = token;
      let job: ImageExecutionJob;
      try {
        job = start({ seed, signal,
          onProgress({ event }) {
            if (active !== token || signal.aborted) return;
            try {
              void Promise.resolve(onProgress({ event })).catch(() => undefined);
            } catch { /* Presentation cannot own native success. */ }
          },
          onPreview({ frame }) {
            if (active !== token || signal.aborted) return;
            try {
              void Promise.resolve(onPreview({ frame })).catch(() => undefined);
            } catch { /* Presentation cannot own native success. */ }
          },
        });
      } catch (error) {
        active = undefined; throw error;
      }
      // Cancellation does not release the reservation: the backend must settle
      // after its work retires. A delayed cancel may not affect a later image.
      const result = job.result.finally(() => {
        if (active === token) active = undefined;
      });
      const update = job.updatePreview;
      return {
        result,
        cancel() {
          if (active === token) job.cancel();
        },
        updatePreview: update === undefined ? undefined : ({ settings }) => {
          if (active === token) update({ settings });
        },
      };
    },
  };
}
export const TEST_ONLY = {
};
