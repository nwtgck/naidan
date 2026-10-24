import type { DeletionPlan } from '@/features/llama-cpp-browser/runtime/deletion-plan';

/** The dialog treats captured directory handles as opaque operation state. */
export function modelRemovalPlan({ modelId, files }: { modelId: string, files: DeletionPlan['files'] }): DeletionPlan {
  const folder = { kind: 'directory', name: 'model-root' } as FileSystemDirectoryHandle;
  return {
    target: { kind: 'model', modelId, location: { kind: 'opfs-user', rootName: 'model-root' } },
    folder,
    parent: folder,
    rootName: 'model-root',
    selectedRelativePaths: files.map(file => file.relativePath),
    sharedProjector: undefined,
    files,
  };
}
