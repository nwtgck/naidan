import {
  createBlobZipSource,
  createWebZipCompressionCodec,
  iterateZipStreamChunks,
  StreamingZipReader,
  type ZipArchiveEntry,
} from '@/utils/zip-stream';

/**
 * Import/export adapter over the environment-independent ZIP core.
 *
 * DEPENDENCY DIRECTION — KEEP IMPORT/EXPORT INDEPENDENT OF WESH
 * =============================================================
 *
 * This module may import `@/utils/zip-stream`. It must never import the Wesh ZIP
 * adapter or any Wesh filesystem module. Import/export runs on the main side;
 * importing Wesh here can bundle worker-only implementation into hosted and
 * standalone application chunks.
 */

export interface IndexedZipFile {
  readonly name: string,
  readonly isDirectory: boolean,
  readText(): Promise<string>,
  readBlob(): Promise<Blob>,
}

export interface IndexedZipArchive {
  readonly fileNames: readonly string[],
  file({ name }: { name: string }): IndexedZipFile | undefined,
  close(): Promise<void>,
}

function createBlobPart({ chunk }: { chunk: Uint8Array }): BlobPart {
  if (chunk.buffer instanceof ArrayBuffer) {
    if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
      return chunk.buffer;
    }
    return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
  }
  return chunk.slice().buffer;
}

function createIndexedZipFile({
  reader,
  entry,
}: {
  reader: StreamingZipReader,
  entry: ZipArchiveEntry,
}): IndexedZipFile {
  return {
    name: entry.name,
    isDirectory: entry.isDirectory,
    async readText() {
      const decoder = new TextDecoder();
      const textParts: string[] = [];
      const stream = await reader.openEntry({ entry });
      for await (const chunk of iterateZipStreamChunks({ stream })) {
        textParts.push(decoder.decode(chunk, { stream: true }));
      }
      textParts.push(decoder.decode());
      return textParts.join('');
    },
    async readBlob() {
      const parts: BlobPart[] = [];
      const stream = await reader.openEntry({ entry });
      for await (const chunk of iterateZipStreamChunks({ stream })) {
        parts.push(createBlobPart({ chunk }));
      }
      return new Blob(parts);
    },
  };
}

export async function openIndexedZipArchive({
  blob,
}: {
  blob: Blob,
}): Promise<IndexedZipArchive> {
  const reader = new StreamingZipReader({
    source: createBlobZipSource({ blob }),
    compressionCodec: createWebZipCompressionCodec(),
  });

  try {
    const files = new Map<string, IndexedZipFile>();
    for await (const entry of reader.entries()) {
      if (files.has(entry.name)) {
        files.delete(entry.name);
      }
      files.set(entry.name, createIndexedZipFile({ reader, entry }));
    }

    return {
      fileNames: [...files.keys()],
      file({ name }) {
        return files.get(name);
      },
      async close() {
        await reader.close();
      },
    };
  } catch (error: unknown) {
    await reader.close();
    throw error;
  }
}
