import { z } from 'zod';
import { modelSchema } from '@/features/llama-cpp-browser/types';

const relativePath = z.string().min(1).refine(path => path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.includes('\\') && !Array.from(part).some(character => character.charCodeAt(0) < 32)));
export const deletionPlanSchema = z.strictObject({
  id: modelSchema.shape.id,
  files: z.array(z.strictObject({ path: relativePath, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), lastModified: z.number().finite() })),
});
export type DeletionPlan = z.infer<typeof deletionPlanSchema>;
export const deletionResultSchema = z.enum(['deleted', 'changed']);
export type DeletionResult = z.infer<typeof deletionResultSchema>;

export async function scanDeletionTree({ folder }: { folder: FileSystemDirectoryHandle }): Promise<{ files: DeletionPlan['files'], directories: string[] }> {
  const files: DeletionPlan['files'] = []; const directories: string[] = [];
  async function visit({ directory, prefix }: { directory: FileSystemDirectoryHandle, prefix: string }): Promise<void> {
    for await (const [name, entry] of directory.entries()) {
      const path = `${prefix}${name}`;
      switch (entry.kind) {
      case 'file': {
        const file = await entry.getFile(); files.push({ path, size: file.size, lastModified: file.lastModified }); break;
      }
      case 'directory': await visit({ directory: entry, prefix: `${path}/` }); directories.push(path); break;
      default: { const exhaustive: never = entry; throw new Error(String(exhaustive)); }
      }
    }
  }
  await visit({ directory: folder, prefix: '' });
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, directories };
}
async function parentDirectory({ folder, path }: { folder: FileSystemDirectoryHandle, path: string }): Promise<{ parent: FileSystemDirectoryHandle, name: string }> {
  const parts = relativePath.parse(path).split('/'); const name = parts.pop()!;
  for (const part of parts) folder = await folder.getDirectoryHandle(part);
  return { parent: folder, name };
}
export async function pruneEmptyDirectories({ folder, directories }: { folder: FileSystemDirectoryHandle, directories: string[] }): Promise<void> {
  for (const path of directories) {
    try {
      const { parent, name } = await parentDirectory({ folder, path });
      await parent.getDirectoryHandle(name); await parent.removeEntry(name);
    } catch (error) {
      if (!(error instanceof DOMException && ['NotFoundError', 'InvalidModificationError', 'TypeMismatchError'].includes(error.name))) throw error;
    }
  }
}
export async function executeDeletionPlan({ folder, plan, selectedPaths }: { folder: FileSystemDirectoryHandle, plan: DeletionPlan, selectedPaths: string[] | undefined }): Promise<DeletionResult> {
  const current = await scanDeletionTree({ folder });
  const files = selectedPaths ? current.files.filter(file => selectedPaths.includes(file.path)) : current.files;
  if (JSON.stringify(files) !== JSON.stringify(plan.files)) return 'changed';
  // Never recursively delete: an external file explorer need not honor our lock.
  for (const file of plan.files) {
    const { parent, name } = await parentDirectory({ folder, path: file.path });
    const latest = await (await parent.getFileHandle(name)).getFile();
    if (latest.size !== file.size || latest.lastModified !== file.lastModified) return 'changed';
    await parent.removeEntry(name);
  }
  if (!selectedPaths) await pruneEmptyDirectories({ folder, directories: current.directories });
  return 'deleted';
}
export const TEST_ONLY = {
};
