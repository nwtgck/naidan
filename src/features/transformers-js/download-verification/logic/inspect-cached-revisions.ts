import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import { isModelWeightFileName } from '@/features/transformers-js/runtime/configure-hosted-runtime';

export type DownloadVerificationCachedRevisionKind = 'legacy-main' | 'immutable-sha' | 'other';

export interface DownloadVerificationCachedRevision {
  revision: string;
  kind: DownloadVerificationCachedRevisionKind;
  totalBytes: number;
  fileCount: number;
  completionMarkerCount: number;
  incompleteFileCount: number;
  zeroByteFileCount: number;
  weightFileCount: number;
  lastModified: number;
  status: 'committed-file-set' | 'partial';
}

export interface DownloadVerificationCachedRevisionInventory {
  modelId: string;
  normalizedModelId: string;
  revisions: DownloadVerificationCachedRevision[];
}

export interface DownloadVerificationCachedRevisionLoadCandidate {
  revision: string;
  loaderRevisionOption: string | undefined;
  source: 'current-resolved-revision' | 'legacy-main' | 'offline-immutable-fallback';
}

function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === 'NotFoundError'
    : error instanceof Error && error.name === 'NotFoundError';
}

function revisionKind({ revision }: { revision: string }): DownloadVerificationCachedRevisionKind {
  if (revision === 'main') return 'legacy-main';
  if (/^[0-9a-f]{40}$/iu.test(revision)) return 'immutable-sha';
  return 'other';
}

async function getResolveDirectory({
  storageRoot,
  normalizedModelId,
}: {
  storageRoot: FileSystemDirectoryHandle;
  normalizedModelId: string;
}): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    let directory = await storageRoot.getDirectoryHandle('models', { create: false });
    directory = await directory.getDirectoryHandle('huggingface.co', { create: false });
    for (const part of normalizedModelId.split('/')) {
      directory = await directory.getDirectoryHandle(part, { create: false });
    }
    return await directory.getDirectoryHandle('resolve', { create: false });
  } catch (error) {
    if (isNotFoundError({ error })) return undefined;
    throw error;
  }
}

async function inspectRevisionDirectory({
  revision,
  directory,
}: {
  revision: string;
  directory: FileSystemDirectoryHandle;
}): Promise<DownloadVerificationCachedRevision> {
  const files = new Map<string, { size: number; lastModified: number; isWeightFile: boolean }>();
  const markers = new Set<string>();

  const scan = async ({ current, relativePath }: {
    current: FileSystemDirectoryHandle;
    relativePath: string;
  }): Promise<void> => {
    for await (const [name, handle] of current.entries()) {
      const path = relativePath.length === 0 ? name : `${relativePath}/${name}`;
      switch (handle.kind) {
      case 'file': {
        if (name.startsWith('.') && name.endsWith('.complete')) {
          markers.add(path);
          break;
        }
        const file = await (handle as FileSystemFileHandle).getFile();
        files.set(path, {
          size: file.size,
          lastModified: file.lastModified,
          isWeightFile: isModelWeightFileName({ fileName: name }),
        });
        break;
      }
      case 'directory':
        await scan({ current: handle as FileSystemDirectoryHandle, relativePath: path });
        break;
      default: {
        const _ex: never = handle;
        throw new Error(`Unhandled FileSystemHandle: ${String(_ex)}`);
      }
      }
    }
  };
  await scan({ current: directory, relativePath: '' });

  let incompleteFileCount = 0;
  let zeroByteFileCount = 0;
  let weightFileCount = 0;
  let totalBytes = 0;
  let lastModified = 0;
  for (const [path, file] of files) {
    const parts = path.split('/');
    const fileName = parts.pop()!;
    const parent = parts.join('/');
    const markerPath = parent.length === 0
      ? `.${fileName}.complete`
      : `${parent}/.${fileName}.complete`;
    if (!markers.has(markerPath)) incompleteFileCount++;
    if (file.size === 0) zeroByteFileCount++;
    if (file.isWeightFile) weightFileCount++;
    totalBytes += file.size;
    lastModified = Math.max(lastModified, file.lastModified);
  }

  const committedFileSet = files.size > 0
    && incompleteFileCount === 0
    && zeroByteFileCount === 0
    && weightFileCount > 0;
  return {
    revision,
    kind: revisionKind({ revision }),
    totalBytes,
    fileCount: files.size,
    completionMarkerCount: markers.size,
    incompleteFileCount,
    zeroByteFileCount,
    weightFileCount,
    lastModified,
    status: committedFileSet ? 'committed-file-set' : 'partial',
  };
}

export async function inspectDownloadVerificationCachedRevisions({
  modelId,
  storageRoot,
}: {
  modelId: string;
  storageRoot: FileSystemDirectoryHandle;
}): Promise<DownloadVerificationCachedRevisionInventory> {
  const normalizedModelId = normalizeTransformersJsProductionModelId({ modelId });
  const resolveDirectory = await getResolveDirectory({ storageRoot, normalizedModelId });
  if (resolveDirectory === undefined) return { modelId, normalizedModelId, revisions: [] };

  const revisions: DownloadVerificationCachedRevision[] = [];
  for await (const [revision, handle] of resolveDirectory.entries()) {
    switch (handle.kind) {
    case 'directory':
      revisions.push(await inspectRevisionDirectory({
        revision,
        directory: handle as FileSystemDirectoryHandle,
      }));
      break;
    case 'file':
      break;
    default: {
      const _ex: never = handle;
      throw new Error(`Unhandled FileSystemHandle: ${String(_ex)}`);
    }
    }
  }
  revisions.sort((left, right) => left.revision.localeCompare(right.revision));
  return { modelId, normalizedModelId, revisions };
}

export function planDownloadVerificationCachedRevisionLoadCandidates({
  inventory,
  resolvedRevision,
}: {
  inventory: DownloadVerificationCachedRevisionInventory;
  resolvedRevision: string | undefined;
}): DownloadVerificationCachedRevisionLoadCandidate[] {
  const committed = inventory.revisions.filter(revision => revision.status === 'committed-file-set');
  const main = committed.find(revision => revision.kind === 'legacy-main');

  if (resolvedRevision !== undefined) {
    const current = committed.find(revision => (
      revision.kind === 'immutable-sha' && revision.revision === resolvedRevision
    ));
    return [
      ...(current === undefined ? [] : [{
        revision: current.revision,
        loaderRevisionOption: current.revision,
        source: 'current-resolved-revision' as const,
      }]),
      ...(main === undefined ? [] : [{
        revision: main.revision,
        loaderRevisionOption: undefined,
        source: 'legacy-main' as const,
      }]),
    ];
  }

  const immutable = committed
    .filter(revision => revision.kind === 'immutable-sha')
    .sort((left, right) => right.lastModified - left.lastModified || left.revision.localeCompare(right.revision));
  return [
    ...(main === undefined ? [] : [{
      revision: main.revision,
      loaderRevisionOption: undefined,
      source: 'legacy-main' as const,
    }]),
    ...immutable.map(revision => ({
      revision: revision.revision,
      loaderRevisionOption: revision.revision,
      source: 'offline-immutable-fallback' as const,
    })),
  ];
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  revisionKind,
};
