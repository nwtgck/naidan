import { peerAllowedMethodsSchema } from '@/features/naidan-peer-rpc/contract';
import type { NaidanPeerControlledMethodName } from '@/features/naidan-peer-rpc/contract';

type Names = readonly NaidanPeerControlledMethodName[];
export type MethodAccessState = {
  effective: Names;
  desired: Names;
  saved: Names;
  revision: number;
  persistence: 'temporary' | 'saved' | 'saving' | 'failed';
};
/** Per-connection inbound authority. Persisted names are concrete methods,
 * never a group or wildcard. The save callback must compare expectedRevision.
 * A stale save may advance the storage revision but cannot grant live access. */
export function createMethodAccess({ initial, stored, revision, persist, apply, changed }: {
  initial: Names; stored: Names; revision: number;
  persist: (({ allowedMethods, expectedRevision }: { allowedMethods: Names; expectedRevision: number }) => Promise<number>) | undefined;
  apply({ allowedMethods }: { allowedMethods: Names }): void;
  changed({ state }: { state: MethodAccessState }): void;
}) {
  const validate = ({ names }: { names: Names }): Names => Object.freeze(peerAllowedMethodsSchema.parse(names));
  let effective = validate({ names: initial }), desired = effective, saved = validate({ names: stored });
  let currentRevision = revision, intent = 0, disposed = false;
  // A retained restriction can differ from the actual stored record after a
  // failed save or a disconnect during revocation. Never label it saved.
  const matchesStored = effective.length === saved.length && effective.every(name => saved.includes(name));
  let persistence: MethodAccessState['persistence'] = persist ? (matchesStored ? 'saved' : 'failed') : 'temporary';
  let queue: Promise<void> = Promise.resolve();
  const state = (): MethodAccessState => ({ effective, desired, saved, revision: currentRevision, persistence });
  const publish = () => {
    try {
      changed({ state: state() });
    } catch { /* Observation is not authority. */ }
  };
  const install = ({ names }: { names: Names }) => {
    // Revocation can synchronously call back into close/update/disconnect.
    // Publish the reduced authority before invoking external cancellation code;
    // never overwrite the newer state installed by that reentrant operation.
    effective = names; apply({ allowedMethods: names });
  };
  return {
    state,
    /** A metadata-only write may advance the record revision without changing
     * the stored method list. It must not confirm an unsaved restriction or
     * install authority into a running session. */
    adoptStoredRevision({ revision }: { revision: number }): void {
      if (disposed || !Number.isSafeInteger(revision) || revision < currentRevision) throw new Error('Unexpected connection storage revision');
      currentRevision = revision;
    },
    update({ allowedMethods }: { allowedMethods: Names }): Promise<void> {
      if (disposed) return Promise.reject(new Error('The connection access controller is closed'));
      let next: Names;
      try {
        next = validate({ names: allowedMethods });
      } catch (error) {
        return Promise.reject(error);
      }
      const accepted = ++intent; desired = next;
      // Mixed edits first revoke removals. Never install uncommitted additions.
      try {
        install({ names: Object.freeze(effective.filter(name => next.includes(name))) });
      } catch (error) {
        if (!disposed && accepted === intent) {
          persistence = 'failed'; publish();
        }
        return Promise.reject(error);
      }
      if (disposed || accepted !== intent) return Promise.resolve();
      if (!persist) {
        try {
          install({ names: next });
          if (!disposed && accepted === intent) {
            persistence = 'temporary'; publish();
          }
          return Promise.resolve();
        } catch (error) {
          if (!disposed && accepted === intent) {
            persistence = 'failed'; publish();
          }
          return Promise.reject(error);
        }
      }
      persistence = 'saving'; publish();
      const task = queue.catch(() => {}).then(async () => {
        // An edit superseded before any write starts need not touch persistence.
        if (disposed || accepted !== intent) return;
        try {
          const revision = await persist({ allowedMethods: next, expectedRevision: currentRevision });
          if (!Number.isSafeInteger(revision) || revision !== currentRevision + 1) throw new Error('Unexpected connection storage revision');
          currentRevision = revision; saved = next;
          if (disposed || accepted !== intent) return;
          install({ names: next });
          if (!disposed && accepted === intent) persistence = 'saved';
        } catch (error) {
          if (!disposed && accepted === intent) persistence = 'failed';
          throw error;
        } finally {
          if (!disposed && accepted === intent) publish();
        }
      });
      queue = task; void task.catch(() => {});
      return task;
    },
    /** Invalidates pending grant additions before the session/owner changes.
     * This does not claim that a pending storage write can be rolled back. */
    close(): void {
      if (disposed) return;
      disposed = true; intent++;
      try {
        install({ names: Object.freeze([]) });
      } finally {
        publish();
      }
    },
    async settled(): Promise<void> {
      await queue.catch(() => {});
    },
  };
}
export const TEST_ONLY = {
};
