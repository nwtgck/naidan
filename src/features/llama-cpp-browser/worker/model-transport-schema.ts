import { z } from 'zod';
import { modelFileSchema, modelFileSnapshotSchema, temporaryModelFileSchema, type ModelFile } from '@/logic/model-file-system';
import type { ModelDirectory, ResolvedModel } from '@/features/llama-cpp-browser/runtime/model-directory';
import { createModelDirectorySchema, createResolvedModelSchema, sameCapturedModelFile } from '@/features/llama-cpp-browser/runtime/resolved-model-schema';

/** Reader representation, not a new storage location. Keep provenance and the
 * captured File; never reopen a path that may now name a replacement. */
const snapshotModelFileSchema = z.object({
  relativePath: z.string(),
  file: modelFileSnapshotSchema,
  storageKind: z.enum(['opfs', 'host']),
  snapshotId: z.string().min(1).max(128),
}).strict();
export type SnapshotModelFile = z.infer<typeof snapshotModelFileSchema>;
export type PortableModelFile = SnapshotModelFile | Extract<ModelFile, { storageKind: 'temp' }>;
export type WorkerModelFile = ModelFile | SnapshotModelFile;
export type WorkerModelDirectory = ModelDirectory<WorkerModelFile>;
export type WorkerResolvedModel = ResolvedModel<WorkerModelFile>;
export type PortableResolvedModel = ResolvedModel<PortableModelFile>;
export type PortableModelRequest<T> = Omit<T, 'resolvedModel'> & { resolvedModel: PortableResolvedModel };

function sameWorkerModelFile({ entry, selected }: { entry: WorkerModelFile, selected: WorkerModelFile }): boolean {
  if ('snapshotId' in entry || 'snapshotId' in selected) {
    return 'snapshotId' in entry && 'snapshotId' in selected
      && entry.relativePath === selected.relativePath && entry.file === selected.file
      && entry.storageKind === selected.storageKind && entry.snapshotId === selected.snapshotId;
  }
  return sameCapturedModelFile({ entry, selected });
}

export const workerResolvedModelSchema = createResolvedModelSchema({
  directorySchema: createModelDirectorySchema({
    entrySchema: z.union([modelFileSchema, snapshotModelFileSchema]),
    sameEntry: sameWorkerModelFile,
  }),
});
export const portableResolvedModelSchema = createResolvedModelSchema({
  directorySchema: createModelDirectorySchema({
    entrySchema: z.union([snapshotModelFileSchema, temporaryModelFileSchema]),
    sameEntry: sameWorkerModelFile,
  }),
});

export const TEST_ONLY = {
};
