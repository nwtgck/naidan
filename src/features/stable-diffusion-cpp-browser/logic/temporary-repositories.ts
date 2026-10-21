import type { TemporaryModelDirectory } from '@/01-models/temporary-model-files';
import { temporaryRootIdSchema } from '@/01-models/temporary-model-files';
import type { LocalImageRepository } from './repository-store';
import type { ModelInventory } from './model-candidates';

export function temporaryImageRepositories({ roots }: { roots: readonly TemporaryModelDirectory[] }): LocalImageRepository[] {
  return roots.map(root => ({ id: root.id, name: root.name, files: root.files.map(({ path, file }) => ({ path, file })) }));
}

/** Structured cloning the inspection response creates fresh File wrappers.
 * Restore the page's original snapshots so an unrelated inventory refresh does
 * not invalidate the inference session's File-identity cache. The caller must
 * discard the scan if a captured root was replaced while inspection was running. */
export function restoreTemporaryImageFiles({ inventory, roots }: { inventory: ModelInventory, roots: readonly TemporaryModelDirectory[] }): ModelInventory {
  const files = new Map(roots.map(root => [root.id, new Map(root.files.map(entry => [entry.path, entry.file]))]));
  return {
    ...inventory,
    candidates: inventory.candidates.map(candidate => {
      if (!temporaryRootIdSchema.safeParse(candidate.repositoryId).success) {
        return candidate;
      }
      const root = files.get(candidate.repositoryId);
      if (!root) {
        throw new Error('Temporary model folder disappeared during inspection');
      }
      return {
        ...candidate,
        files: candidate.files.map(entry => {
          const file = root.get(entry.path);
          if (!file) {
            throw new Error('Temporary model file disappeared during inspection');
          }
          return { ...entry, file };
        }),
      };
    }),
  };
}

export const TEST_ONLY = {
};
