import { FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION } from '@/utils/worker-transport-capabilities';
import { prepareWorkerCapability, type WorkerCapability } from '@/utils/worker-transport';
import type { StoredModelFile } from '@/logic/model-file-system';
import { portableResolvedModelSchema, type PortableModelFile, type PortableModelRequest, type PortableResolvedModel, type WorkerResolvedModel } from './model-transport-schema';

/** One client's most recently transported model, bounded by that model's files.
 * IDs certify source identity for resident-cache reuse, not content immutability.
 * Like the direct path, reuse also requires matching size/mtime and isSameEntry.
 */
export function createModelTransport() {
  let epoch = 0;
  let identity: string | undefined;
  let previous = new Map<string, { entry: StoredModelFile, snapshotId: string }>();
  async function portable({ model, signal }: { model: WorkerResolvedModel, signal: AbortSignal | undefined }): Promise<PortableResolvedModel> {
    signal?.throwIfAborted();
    const acceptedEpoch = epoch;
    const key = JSON.stringify([model.modelId, model.location]);
    const candidates = identity === key ? previous : new Map<string, { entry: StoredModelFile, snapshotId: string }>();
    const next = new Map<string, { entry: StoredModelFile, snapshotId: string }>();
    const files: PortableModelFile[] = [];
    for (const entry of model.directory.files) {
      signal?.throwIfAborted();
      if (entry.storageKind === 'temp' || 'snapshotId' in entry) {
        files.push(entry);
        continue;
      }
      const old = candidates.get(entry.relativePath);
      let same = false;
      if (old && old.entry.storageKind === entry.storageKind
        && old.entry.file.size === entry.file.size && old.entry.file.lastModified === entry.file.lastModified) {
        try {
          same = old.entry.handle === entry.handle || await old.entry.handle.isSameEntry(entry.handle);
        } catch { /* Unknown identity must reload, never reuse a resident model. */ }
      }
      signal?.throwIfAborted();
      const snapshotId = same && old ? old.snapshotId : crypto.randomUUID();
      next.set(entry.relativePath, { entry, snapshotId });
      const { relativePath, file, storageKind, handle: _handle, ...unhandledEntry } = entry;
      unhandledEntry satisfies Record<PropertyKey, never>;
      files.push({ relativePath, file, storageKind, snapshotId });
    }
    const { directory, ...root } = model;
    const { primaryFile, projectorFile, files: _files, ...unhandledDirectory } = directory;
    unhandledDirectory satisfies Record<PropertyKey, never>;
    const resolved = portableResolvedModelSchema.parse({
      ...root,
      directory: {
        files,
        primaryFile: files.find(entry => entry.relativePath === primaryFile.relativePath),
        projectorFile: files.find(entry => entry.relativePath === projectorFile?.relativePath),
      },
    });
    if (acceptedEpoch === epoch) {
      identity = key;
      previous = next;
    }
    return resolved;
  }
  return {
    portable,
    async prepare<T extends { resolvedModel: WorkerResolvedModel }>({ request, signal }: { request: T, signal: AbortSignal | undefined }): Promise<WorkerCapability<T, typeof FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION> | PortableModelRequest<T>> {
      signal?.throwIfAborted();
      const prepared = await prepareWorkerCapability({
        value: request,
        capability: FILE_SYSTEM_HANDLE_CLONING_REQUIRES_SUCCESSFUL_RUNTIME_FEATURE_DETECTION,
        fallback: async () => ({ ...request, resolvedModel: await portable({ model: request.resolvedModel, signal }) }),
      });
      signal?.throwIfAborted();
      return prepared;
    },
    clear() {
      epoch++;
      identity = undefined;
      previous.clear();
    },
  };
}

export const TEST_ONLY = {
};
