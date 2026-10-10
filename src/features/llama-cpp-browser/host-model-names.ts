import { storageService } from '@/00-storage/service';
import { selectHostModel } from './runtime/host-model-store';
import { resolveHostModelName } from './runtime/host-model-aliases';

/** Resolve once when accepting an operation, before waiting for the native lane.
 * Workers and filesystem operations only receive canonical storage identities.
 */
export async function resolveStoredModelName({ name }: { name: string }): Promise<string> {
  if (!name.startsWith('host/')) return name;
  const directories = await storageService.loadHostModelDirectories();
  const reference = resolveHostModelName({ name, directories });
  // Capture the inventory selection as well as the root before queueing. Later
  // renames or newly added variants must not retarget an accepted operation.
  return (await selectHostModel({ name: reference })).id;
}

export const TEST_ONLY = {
};
