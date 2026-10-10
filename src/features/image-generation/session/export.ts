import type { ImageGenerationExportSnapshot } from '@/00-storage/service/image-generation-export';
import { idToRaw } from '@/01-models/ids';
import { createMemoryZipCentralDirectoryStore, createReadableZipOutput } from '@/utils/zip-stream/memory';
import { StreamingZipWriter, createWebZipCompressionCodec } from '@/utils/zip-stream';

/** Stream originals with backpressure. The caller owns the download and abort
 * signal. Neither navigation nor successful generation automatically downloads. */
export function createImageGenerationArchive({ snapshot, exportedAt }: { snapshot: ImageGenerationExportSnapshot, exportedAt: number }) {
  const output = createReadableZipOutput({ highWaterMarkBytes: 256 * 1024 });
  const directory = createMemoryZipCentralDirectoryStore();
  const writer = new StreamingZipWriter({ output: output.sink, centralDirectoryStore: directory, compressionCodec: createWebZipCompressionCodec() });
  const modifiedAt = new Date(exportedAt);
  async function add({ path, blob }: { path: string, blob: Blob }): Promise<void> {
    await writer.addFile({ name: path, modifiedAt, compression: 'store', stream: blob.stream() });
  }
  const completed = (async () => {
    try {
      await add({
        path: 'README.txt',
        blob: new Blob([
          'Naidan Image Generation session export\n\n',
          'Experimental metadata may change between versions. This archive preserves the current canonical records and original image bytes.\n',
          'metadata/catalog.json contains only tag definitions used by this session. Cross-session lineage references are preserved but other sessions are not copied.\n',
          'images/<binary-object-id>.<extension> maps to binaryObjectId in the metadata. Input images and saved previews are included. Model weights are not included.\n',
          'metadata/deleted-binaries records deliberate permanent deletions. Their bytes are excluded even when another run or draft still references them. Archived images are included.\n',
          'Generated settings are snapshots, not a promise of identical pixels across devices, runtime versions, or modified model files.\n',
          `Exported at: ${modifiedAt.toISOString()}\n`,
        ], { type: 'text/plain' }),
      });
      for (const entry of snapshot.metadata) await add({ path: `metadata/${entry.path}`, blob: entry.blob });
      for (const { id, blob } of snapshot.binaries) {
        const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'bin';
        await add({ path: `images/${idToRaw({ id })}.${extension}`, blob });
      }
      await writer.finalize(); await output.close();
    } catch (error) {
      await output.abort({ reason: error }).catch(() => undefined); throw error;
    } finally {
      await directory.dispose();
    }
  })();
  // The stream reports the same failure to the download consumer.
  void completed.catch(() => undefined);
  return { stream: output.stream, completed };
}

export const TEST_ONLY = {
};
