import { opfsFormat } from '@/00-format/01-layout/layout';
import { idToRaw, type BinaryObjectId } from '@/01-models/ids';
import { imageGenerationRootIo } from './context';

/** A validated deletion marker is also part of an export when another run still
 * refers to deliberately removed bytes. Unknown missing files remain errors. */
export function readImageGenerationBinaryDeletion({ directory, id }: {
  directory: FileSystemDirectoryHandle, id: BinaryObjectId,
}): Promise<Blob | undefined> {
  return opfsFormat.storage.experimental.imageGeneration.deletedBinaries.forId({ id: idToRaw({ id }) }).captureForExport({ io: imageGenerationRootIo({ directory }) });
}

export async function assertImageGenerationBinariesNotDeleted({ directory, ids }: { directory: FileSystemDirectoryHandle, ids: BinaryObjectId[] }): Promise<void> {
  const io = imageGenerationRootIo({ directory });
  for (const id of new Set(ids)) {
    if (await opfsFormat.storage.experimental.imageGeneration.deletedBinaries.forId({ id: idToRaw({ id }) }).isMarked({ io })) {
      throw new Error('An image was permanently deleted. Remove it from the draft before saving or generating again.');
    }
  }
}

export async function markImageGenerationBinariesDeleted({ directory, ids }: { directory: FileSystemDirectoryHandle, ids: BinaryObjectId[] }): Promise<void> {
  const io = imageGenerationRootIo({ directory });
  for (const id of new Set(ids)) {
    await opfsFormat.storage.experimental.imageGeneration.deletedBinaries.forId({ id: idToRaw({ id }) }).mark({ io });
  }
}

export const TEST_ONLY = {
};
