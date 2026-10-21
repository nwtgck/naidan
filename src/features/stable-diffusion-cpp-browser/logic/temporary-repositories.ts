import type { TemporaryModelDirectory } from '@/01-models/temporary-model-files';
import { temporaryRootPathSchema } from '@/01-models/temporary-model-files';
import { readTemporaryModelFile } from '@/logic/model-file-system';
import type { LocalImageRepository } from './repository-store';
import type { ModelInventory } from './model-candidates';

export function temporaryImageRepositories({ roots }: { roots: readonly TemporaryModelDirectory[] }): LocalImageRepository[] {
  return roots.map(root => ({
    repositoryKey: root.rootPath,
    repositoryLabel: root.rootName,
    files: root.files.map(({ relativePath }) => {
      const source = readTemporaryModelFile({ root, relativePath });
      return { relativePath: source.relativePath, file: source.file };
    }),
  }));
}

/** Structured cloning the inspection response creates fresh File wrappers.
 * Restore the page's original snapshots so an unrelated inventory refresh does
 * not invalidate the inference session's File-identity cache. The caller must
 * discard the scan if a captured root was replaced while inspection was running. */
export function restoreTemporaryImageFiles({ inventory, roots }: { inventory: ModelInventory, roots: readonly TemporaryModelDirectory[] }): ModelInventory {
  const files = new Map(roots.map(root => [root.rootPath, new Map(root.files.map(entry => [entry.relativePath, entry.file]))]));
  return {
    ...inventory,
    candidates: inventory.candidates.map(candidate => {
      if (!temporaryRootPathSchema.safeParse(candidate.repositoryKey).success) {
        return candidate;
      }
      const root = files.get(candidate.repositoryKey);
      if (!root) {
        throw new Error('Temporary model folder disappeared during inspection');
      }
      return {
        ...candidate,
        files: candidate.files.map(entry => {
          const file = root.get(entry.relativePath);
          if (!file) {
            throw new Error('Temporary model file disappeared during inspection');
          }
          const { relativePath, file: _file, receipt, ...unhandledEntry } = entry;
          unhandledEntry satisfies Record<PropertyKey, never>;
          return { relativePath, file, ...(receipt ? { receipt } : {}) };
        }),
      };
    }),
  };
}

export const TEST_ONLY = {
};
