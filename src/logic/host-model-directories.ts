import { hostModelHandles } from '@/00-storage/service/host-model-handles';
import { idToRaw, type HostModelDirectoryId } from '@/01-models/ids';

export function hostModelPermissionGranted({ permission }: { permission: PermissionState }): boolean {
  switch (permission) {
  case 'granted': return true;
  case 'denied': case 'prompt': return false;
  default: { const exhaustive: never = permission; throw new Error(String(exhaustive)); }
  }
}

export function hostModelDirectoryLock({ id }: { id: HostModelDirectoryId }): string {
  return `naidan-host-model-directory:${idToRaw({ id })}`;
}

/** Unregistering never deletes user files. The same lock is held by downloads,
 * so removing a registration cannot leave an owned writer running behind it.
 */
export async function unregisterHostModelDirectory({ id, save, restore }: {
  id: HostModelDirectoryId, save: () => Promise<void>, restore: () => Promise<void>,
}): Promise<void> {
  await navigator.locks.request(hostModelDirectoryLock({ id }), async () => {
    await save();
    try {
      await hostModelHandles.delete({ id });
    } catch (error) {
      try {
        await restore();
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], 'Registration was removed, but its stored handle could not be removed and the registration could not be restored. Model files are unchanged.');
      }
      throw new Error('Could not remove the stored handle. The model directory registration was restored; retry removal.', { cause: error });
    }
  });
}

export const TEST_ONLY = {
};
