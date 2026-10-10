import type { BinaryObjectId } from '@/01-models/ids';
import type { IStorageProvider } from './interface';

export type ImageGenerationBinaryFile = { binaryObjectId: BinaryObjectId, blob: Blob, name: string };

/** Called inside the metadata + Workspace locks with the provider captured before
 * awaiting. BinaryObjects are shared, so retries may verify but never overwrite. */
export async function publishImageGenerationBinaries({ provider, referenced, files }: {
  provider: Pick<IStorageProvider, 'getFile' | 'getBinaryObject' | 'saveFile'>, referenced: BinaryObjectId[], files: ImageGenerationBinaryFile[],
}): Promise<void> {
  const references = new Set(referenced);
  const supplied = new Set<BinaryObjectId>();
  for (const file of files) {
    if (!references.has(file.binaryObjectId) || supplied.has(file.binaryObjectId)) throw new Error('Image Generation files must match unique record references.');
    supplied.add(file.binaryObjectId);
  }
  for (const { binaryObjectId, blob, name } of files) {
    const existing = await provider.getFile({ binaryObjectId });
    const metadata = await provider.getBinaryObject({ binaryObjectId });
    if (metadata && !existing) throw new Error('An Image Generation binary object is missing or unreadable.');
    if (existing) {
      if (existing.size !== blob.size || metadata && existing.type !== blob.type) throw new Error('Image Generation binary objects are immutable.');
      for (let offset = 0; offset < blob.size; offset += 65536) {
        const left = new Uint8Array(await existing.slice(offset, offset + 65536).arrayBuffer());
        const right = new Uint8Array(await blob.slice(offset, offset + 65536).arrayBuffer());
        if (left.some((byte, index) => byte !== right[index])) throw new Error('Image Generation binary objects are immutable.');
      }
    }
    if (!existing || !metadata) await provider.saveFile({ binaryObjectId, blob, name, mimeType: blob.type || undefined });
  }
  for (const binaryObjectId of references) {
    if (!await provider.getFile({ binaryObjectId }) || !await provider.getBinaryObject({ binaryObjectId })) throw new Error('Image Generation references a missing or unpublished binary object.');
  }
}

export const TEST_ONLY = {
};
