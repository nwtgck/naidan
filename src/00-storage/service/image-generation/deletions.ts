import { ExperimentalImageGenerationBinaryDeletionSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationDirectory, imageGenerationRawIdSchema, readImageGenerationText, writeImageGenerationText } from './files';

async function markerDirectory({ directory, id, create }: { directory: FileSystemDirectoryHandle, id: string, create: boolean }): Promise<FileSystemDirectoryHandle | undefined> {
  imageGenerationRawIdSchema.parse(id);
  const root = await imageGenerationDirectory({ parent: directory, name: 'deleted-binaries', create });
  return root && imageGenerationDirectory({ parent: root, name: id.slice(-2).toLowerCase(), create });
}

async function readMarker({ directory, id }: { directory: FileSystemDirectoryHandle, id: string }): Promise<boolean> {
  const text = await readImageGenerationText({ directory, name: `${id}.json` });
  if (text === undefined) return false;
  const record = ExperimentalImageGenerationBinaryDeletionSchemaDto.parse(JSON.parse(text));
  if (record.binaryObjectId !== id) throw new Error('Image Generation binary deletion identity mismatch.');
  return true;
}

/** A validated deletion marker is also part of an export when another run still
 * refers to deliberately removed bytes. Unknown missing files remain errors. */
export async function readImageGenerationBinaryDeletion({ directory, id }: { directory: FileSystemDirectoryHandle, id: string }): Promise<Blob | undefined> {
  const shard = await markerDirectory({ directory, id, create: false });
  if (!shard || !await readMarker({ directory: shard, id })) return undefined;
  return (await shard.getFileHandle(`${id}.json`)).getFile();
}

export async function assertImageGenerationBinariesNotDeleted({ directory, ids }: { directory: FileSystemDirectoryHandle, ids: string[] }): Promise<void> {
  for (const id of new Set(ids)) {
    const shard = await markerDirectory({ directory, id, create: false });
    if (shard && await readMarker({ directory: shard, id })) throw new Error('An image was permanently deleted. Remove it from the draft before saving or generating again.');
  }
}

export async function markImageGenerationBinariesDeleted({ directory, ids }: { directory: FileSystemDirectoryHandle, ids: string[] }): Promise<void> {
  for (const id of new Set(ids)) {
    const shard = await markerDirectory({ directory, id, create: true });
    if (!shard) throw new Error('Image Generation deletion directory is unavailable.');
    if (!await readMarker({ directory: shard, id })) await writeImageGenerationText({ directory: shard, name: `${id}.json`, text: JSON.stringify(ExperimentalImageGenerationBinaryDeletionSchemaDto.parse({ binaryObjectId: id })) });
  }
}

export const TEST_ONLY = {
};
