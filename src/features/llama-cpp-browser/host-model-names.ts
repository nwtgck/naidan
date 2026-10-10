import { storageService } from '@/00-storage/service';
import { resolveHostModelName } from './runtime/host-model-aliases';

/** Resolve once when accepting an operation, before waiting for the native lane.
 * Workers and filesystem operations only receive canonical storage identities.
 */
export async function resolveStoredModelName({ name }: { name: string }): Promise<string> {
  if (!name.startsWith('host/')) return name;
  const directories = await storageService.loadHostModelDirectories();
  return resolveHostModelName({ name, directories });
}

export const TEST_ONLY = {
};
