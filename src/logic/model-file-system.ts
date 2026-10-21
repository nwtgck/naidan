import { z } from 'zod';
import type { BrowserImageModelLocation } from '@/01-models/types';
import type { TemporaryModelDirectory } from '@/01-models/temporary-model-files';
import { temporaryRootPathSchema } from '@/01-models/temporary-model-files';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { OPFS_MODELS_DIR } from '@/constants';

/** A captured file relative to one model root, with its reader provenance. */
export type ModelFile = { relativePath: string, file: File } & (
  | { storageKind: 'opfs', handle: FileSystemFileHandle }
  | { storageKind: 'host', handle: FileSystemFileHandle }
  | { storageKind: 'temp', registrationRevision: number }
);
export type StoredModelFile = Extract<ModelFile, { handle: FileSystemFileHandle }>;

const fileSchema = z.custom<File>(value => typeof File !== 'undefined' && value instanceof File && Number.isSafeInteger(value.size) && value.size >= 0);
const handleSchema = z.custom<FileSystemFileHandle>(value => typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'file' && 'getFile' in value && typeof value.getFile === 'function');
const commonShape = { relativePath: z.string(), file: fileSchema };
// Source-specific path admission and publication policy remain with each caller.
export const modelFileSchema = z.discriminatedUnion('storageKind', [
  z.object({ ...commonShape, storageKind: z.literal('opfs'), handle: handleSchema }).strict(),
  z.object({ ...commonShape, storageKind: z.literal('host'), handle: handleSchema }).strict(),
  z.object({ ...commonShape, storageKind: z.literal('temp'), registrationRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
]) satisfies z.ZodType<ModelFile>;

/** Capture a snapshot without changing either engine's publication rules. */
export async function readStoredModelFile({ relativePath, handle, storageKind, signal }: {
  relativePath: string, handle: FileSystemFileHandle, storageKind: 'opfs' | 'host', signal: AbortSignal | undefined,
}): Promise<StoredModelFile> {
  signal?.throwIfAborted();
  const file = await handle.getFile();
  signal?.throwIfAborted();
  return { relativePath, file, handle, storageKind };
}

// The immutable registration owns this index. Removing/reusing a visible root
// never changes captured operations, and the WeakMap cannot retain removed roots.
const temporaryFileIndices = new WeakMap<TemporaryModelDirectory, Map<string, TemporaryModelDirectory['files'][number]>>();

/** Resolve within the captured registration, without looking up a reused name. */
export function readTemporaryModelFile({ root, relativePath }: { root: TemporaryModelDirectory, relativePath: string }): ModelFile {
  let index = temporaryFileIndices.get(root);
  if (!index) {
    index = new Map();
    for (const entry of root.files) {
      if (index.has(entry.relativePath)) {
        throw new Error('Temporary model file is ambiguous');
      }
      index.set(entry.relativePath, entry);
    }
    temporaryFileIndices.set(root, index);
  }
  const entry = index.get(relativePath);
  if (!entry) {
    throw new Error('Temporary model file is missing');
  }
  return { relativePath, file: entry.file, storageKind: 'temp', registrationRevision: root.registrationRevision };
}

/** Preserve the existing image location format at the persistence boundary. */
export function modelFileLocation({ repositoryKey, hostSource, relativePath }: {
  repositoryKey: string, hostSource: { directoryId: string, directoryName: string, repository: string } | undefined, relativePath: string,
}): BrowserImageModelLocation {
  if (hostSource) {
    const { directoryId, directoryName: _directoryName, repository, ...unhandledSource } = hostSource;
    unhandledSource satisfies Record<PropertyKey, never>;
    return { kind: 'host', directoryId: toHostModelDirectoryId({ raw: directoryId }), path: `${repository}/${relativePath}` };
  }
  if (repositoryKey.startsWith('temp/')) {
    temporaryRootPathSchema.parse(repositoryKey);
    return { kind: 'temp', path: `${repositoryKey}/${relativePath}` };
  }
  return { kind: 'opfs', path: `${OPFS_MODELS_DIR}/${repositoryKey}/${relativePath}` };
}

export const TEST_ONLY = {
};
