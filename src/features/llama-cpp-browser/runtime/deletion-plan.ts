import { z } from 'zod';
import { modelSchema } from '@/features/llama-cpp-browser/types';

import { journalSchema, repositorySchema } from '@/features/llama-cpp-browser/hugging-face/types';

const relativePath = z.string().min(1).refine(path => path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.includes('\\') && !Array.from(part).some(character => character.charCodeAt(0) < 32)));
const directoryHandleSchema = z.custom<FileSystemDirectoryHandle>(value => typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'directory' && 'getDirectoryHandle' in value && typeof value.getDirectoryHandle === 'function' && 'getFileHandle' in value && typeof value.getFileHandle === 'function' && 'removeEntry' in value && typeof value.removeEntry === 'function' && 'entries' in value && typeof value.entries === 'function');
export const repositoryLocationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('hugging-face'), repository: repositorySchema }),
  z.strictObject({ kind: z.literal('host'), directoryId: z.string().min(1).max(255), repository: repositorySchema }),
]);
export type RepositoryLocation = z.infer<typeof repositoryLocationSchema>;
export type ModelRemovalTarget = { kind: 'model', modelId: string } | { kind: 'repository', location: RepositoryLocation };
const storedLocationSchema = z.union([
  repositoryLocationSchema,
  z.strictObject({ kind: z.literal('opfs-user'), rootName: relativePath.refine(path => !path.includes('/')) }),
]);
export const deletionFileSchema = z.strictObject({ relativePath, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), lastModified: z.number().finite() });
export type DeletionFile = z.infer<typeof deletionFileSchema>;
export const deletionPlanSchema = z.strictObject({
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('model'), modelId: modelSchema.shape.modelId, location: storedLocationSchema }),
    z.strictObject({ kind: z.literal('repository'), location: repositoryLocationSchema, journal: journalSchema.or(z.undefined()) }),
  ]),
  folder: directoryHandleSchema,
  parent: directoryHandleSchema,
  rootName: relativePath.refine(path => !path.includes('/')),
  selectedRelativePaths: z.array(relativePath),
  sharedProjector: z.enum(['include', 'keep']).or(z.undefined()),
  files: z.array(deletionFileSchema),
}).refine(plan => new Set(plan.selectedRelativePaths).size === plan.selectedRelativePaths.length && new Set(plan.files.map(file => file.relativePath)).size === plan.files.length && plan.files.every(file => plan.selectedRelativePaths.includes(file.relativePath)));
export type DeletionPlan = z.infer<typeof deletionPlanSchema>;
export const deletionResultSchema = z.enum(['deleted', 'changed']);
export type DeletionResult = z.infer<typeof deletionResultSchema>;

export async function scanDeletionTree({ folder }: { folder: FileSystemDirectoryHandle }): Promise<{ files: DeletionFile[], directories: string[] }> {
  const files: DeletionFile[] = [];
  const directories: string[] = [];
  async function visit({ directory, prefix }: { directory: FileSystemDirectoryHandle, prefix: string }): Promise<void> {
    for await (const [name, entry] of directory.entries()) {
      const path = `${prefix}${name}`;
      switch (entry.kind) {
      case 'file': {
        const file = await entry.getFile();
        files.push({ relativePath: path, size: file.size, lastModified: file.lastModified });
        break;
      }
      case 'directory': await visit({ directory: entry, prefix: `${path}/` });
        directories.push(path);
        break;
      default: {
        const exhaustive: never = entry;
        throw new Error(String(exhaustive));
      }
      }
    }
  }
  await visit({ directory: folder, prefix: '' });
  files.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  return { files, directories };
}

async function parentDirectory({ folder, path }: { folder: FileSystemDirectoryHandle, path: string }): Promise<{ parent: FileSystemDirectoryHandle, name: string }> {
  const parts = relativePath.parse(path).split('/');
  const name = parts.pop()!;
  for (const part of parts) {
    folder = await folder.getDirectoryHandle(part);
  }
  return { parent: folder, name };
}

export async function pruneEmptyDirectories({ folder, directories }: { folder: FileSystemDirectoryHandle, directories: string[] }): Promise<void> {
  for (const path of directories) {
    try {
      const { parent, name } = await parentDirectory({ folder, path });
      await parent.getDirectoryHandle(name);
      await parent.removeEntry(name);
    } catch (error) {
      if (!(error instanceof DOMException && ['NotFoundError', 'InvalidModificationError', 'TypeMismatchError'].includes(error.name))) {
        throw error;
      }
    }
  }
}

export async function executeDeletionPlan({ folder, files, selectedRelativePaths }: { folder: FileSystemDirectoryHandle, files: DeletionFile[], selectedRelativePaths: string[] | undefined }): Promise<DeletionResult> {
  const current = await scanDeletionTree({ folder });
  const selected = selectedRelativePaths ? current.files.filter(file => selectedRelativePaths.includes(file.relativePath)) : current.files;
  if (JSON.stringify(selected) !== JSON.stringify(files)) {
    return 'changed';
  }
  // Never recursively delete: an external file explorer need not honor our lock.
  for (const file of files) {
    try {
      const { parent, name } = await parentDirectory({ folder, path: file.relativePath });
      const latest = await (await parent.getFileHandle(name)).getFile();
      if (latest.size !== file.size || latest.lastModified !== file.lastModified) {
        return 'changed';
      }
      await parent.removeEntry(name);
    } catch (error) {
      if (error instanceof DOMException && ['NotFoundError', 'TypeMismatchError'].includes(error.name)) {
        return 'changed';
      }
      throw error;
    }
  }
  await pruneEmptyDirectories({ folder, directories: selectedRelativePaths ? current.directories.filter(directory => selectedRelativePaths.some(path => path.startsWith(`${directory}/`))) : current.directories });
  return 'deleted';
}

/** The captured parent may now contain a replacement. Pruning is optional and
 * must never remove that replacement, even when it is empty.
 */
export async function pruneCapturedModelRoot({ plan }: { plan: DeletionPlan }): Promise<void> {
  try {
    const current = await plan.parent.getDirectoryHandle(plan.rootName);
    if (current !== plan.folder && (typeof current.isSameEntry !== 'function' || !await current.isSameEntry(plan.folder))) {
      return;
    }
    await plan.parent.removeEntry(plan.rootName);
  } catch (error) {
    if (!(error instanceof DOMException && ['NotFoundError', 'InvalidModificationError', 'TypeMismatchError'].includes(error.name))) {
      throw error;
    }
  }
}

export const TEST_ONLY = {
};
