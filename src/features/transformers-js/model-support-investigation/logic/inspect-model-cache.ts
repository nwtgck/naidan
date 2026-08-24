import type {
  ModelSupportInvestigationCacheFile,
  ModelSupportInvestigationCacheInventory,
} from '@/features/transformers-js/model-support-investigation/types';
import { normalizeHuggingFaceModelId } from '@/features/transformers-js/model-support-investigation/logic/inspect-hugging-face-repository';
import { isModelWeightFileName } from '@/features/transformers-js/runtime/configure-hosted-runtime';

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error && error.name === 'NotFoundError';
}

function repositoryPathFromCachePath({ path }: { path: string }): string | undefined {
  const parts = path.split('/');
  if (parts[0] !== 'resolve' || parts.length < 3) return undefined;
  return parts.slice(2).join('/');
}

function cacheRevisionFromCachePath({ path }: { path: string }): string | undefined {
  const parts = path.split('/');
  if (parts[0] !== 'resolve' || parts.length < 3) return undefined;
  return parts[1];
}

function dataPathForCompletionMarker({ markerPath }: { markerPath: string }): string | undefined {
  const parts = markerPath.split('/');
  const markerName = parts.pop();
  if (markerName === undefined || !markerName.startsWith('.') || !markerName.endsWith('.complete')) {
    return undefined;
  }
  const fileName = markerName.slice(1, -'.complete'.length);
  if (fileName.length === 0) return undefined;
  return parts.length === 0 ? fileName : `${parts.join('/')}/${fileName}`;
}

async function getModelDirectory({
  storageRoot,
  normalizedModelId,
}: {
  storageRoot: FileSystemDirectoryHandle,
  normalizedModelId: string,
}): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    let directory = await storageRoot.getDirectoryHandle('models', { create: false });
    directory = await directory.getDirectoryHandle('huggingface.co', { create: false });
    for (const part of normalizedModelId.split('/')) {
      directory = await directory.getDirectoryHandle(part, { create: false });
    }
    return directory;
  } catch (error) {
    if (isNotFoundError({ error })) return undefined;
    throw error;
  }
}

export async function inspectModelCache({
  modelId,
  storageRoot,
}: {
  modelId: string,
  storageRoot: FileSystemDirectoryHandle,
}): Promise<ModelSupportInvestigationCacheInventory> {
  const normalizedModelId = normalizeHuggingFaceModelId({ modelId });
  const modelDirectory = await getModelDirectory({ storageRoot, normalizedModelId });
  if (modelDirectory === undefined) {
    return {
      normalizedModelId,
      rootPath: `models/huggingface.co/${normalizedModelId}`,
      exists: false,
      revisionProvenance: 'unknown',
      revisionProvenanceReason: 'The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA',
      totalBytes: 0,
      fileCount: 0,
      completionMarkerCount: 0,
      incompleteFileCount: 0,
      orphanCompletionMarkerCount: 0,
      orphanCompletionMarkerPaths: [],
      zeroByteFileCount: 0,
      weightFileCount: 0,
      allFilesHaveCompletionMarkers: false,
      files: [],
    };
  }

  const files: ModelSupportInvestigationCacheFile[] = [];
  const markerPaths = new Set<string>();
  const scan = async ({ directory, relativePath }: {
    directory: FileSystemDirectoryHandle,
    relativePath: string,
  }): Promise<void> => {
    for await (const [name, handle] of directory.entries()) {
      const path = relativePath.length === 0 ? name : `${relativePath}/${name}`;
      switch (handle.kind) {
      case 'file': {
        if (name.startsWith('.') && name.endsWith('.complete')) {
          markerPaths.add(path);
          break;
        }
        const file = await (handle as FileSystemFileHandle).getFile();
        files.push({
          path,
          repositoryPath: repositoryPathFromCachePath({ path }),
          cacheRevision: cacheRevisionFromCachePath({ path }),
          size: file.size,
          lastModified: file.lastModified,
          hasCompletionMarker: false,
          isWeightFile: isModelWeightFileName({ fileName: path.split('/').at(-1) ?? path }),
        });
        break;
      }
      case 'directory':
        await scan({ directory: handle as FileSystemDirectoryHandle, relativePath: path });
        break;
      }
    }
  };
  await scan({ directory: modelDirectory, relativePath: '' });

  for (const file of files) {
    const parts = file.path.split('/');
    const fileName = parts.pop();
    if (fileName === undefined) continue;
    const directoryPath = parts.join('/');
    const markerPath = directoryPath.length === 0
      ? `.${fileName}.complete`
      : `${directoryPath}/.${fileName}.complete`;
    file.hasCompletionMarker = markerPaths.has(markerPath);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const filePaths = new Set(files.map(file => file.path));
  const orphanCompletionMarkerPaths = [...markerPaths]
    .filter((markerPath) => {
      const dataPath = dataPathForCompletionMarker({ markerPath });
      return dataPath === undefined || !filePaths.has(dataPath);
    })
    .sort((a, b) => a.localeCompare(b));
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const incompleteFileCount = files.filter(file => !file.hasCompletionMarker).length;
  const zeroByteFileCount = files.filter(file => file.size === 0).length;
  const weightFileCount = files.filter(file => file.isWeightFile).length;
  return {
    normalizedModelId,
    rootPath: `models/huggingface.co/${normalizedModelId}`,
    exists: true,
    revisionProvenance: 'unknown',
    revisionProvenanceReason: 'The cache path records a requested revision segment, but completion markers do not independently verify file bytes against the resolved Hugging Face commit SHA',
    totalBytes,
    fileCount: files.length,
    completionMarkerCount: markerPaths.size,
    incompleteFileCount,
    orphanCompletionMarkerCount: orphanCompletionMarkerPaths.length,
    orphanCompletionMarkerPaths,
    zeroByteFileCount,
    weightFileCount,
    allFilesHaveCompletionMarkers: files.length > 0 && incompleteFileCount === 0,
    files,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
