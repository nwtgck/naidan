import {
  createBlobZipSource,
  createWebZipCompressionCodec,
  iterateZipStreamChunks,
  StreamingZipReader,
  StreamingZipWriter,
  type ZipArchiveEntry,
} from '@/utils/zip-stream';
import { createMemoryZipCentralDirectoryStore } from '@/utils/zip-stream/memory';

/** Evidence owns immutable file contents; ZIP is only its transport encoding. */
export interface EvidenceArchiveReader {
  readonly paths: readonly string[];
  read({ path }: { path: string }): Promise<Blob | undefined>;
}

function validateEvidencePath({ path }: { path: string }): void {
  if (path.length === 0 || path.includes('\\') || path.includes('\0')
    || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid Evidence archive path');
  }
}

export function setEvidenceFile({ files, path, content }: {
  files: Map<string, Blob>; path: string; content: BlobPart;
}): void {
  validateEvidencePath({ path });
  // Snapshot mutable byte views at insertion, before any compression/hash await.
  // Blob parts share immutable storage; they do not become mutable typed arrays.
  files.set(path, new Blob([content]));
}

export function createEvidenceFilesReader({ files }: {
  files: ReadonlyMap<string, Blob>;
}): EvidenceArchiveReader {
  const owned = new Map(files);
  return {
    paths: [...owned.keys()],
    async read({ path }) {
      return owned.get(path);
    },
  };
}

export async function createEvidenceArchive({ files }: {
  files: ReadonlyMap<string, Blob>;
}): Promise<Blob> {
  // Capture the file set synchronously. Later caller changes cannot alter the
  // relationship between the manifest and the entries currently being written.
  const owned = [...files.entries()];
  // The shared reader treats 0xffff as the ZIP64 marker. Refuse before reading
  // any body: byte budgets alone do not bound a batch of tiny tensor entries.
  // Keep all retained files; splitting/partial evidence belongs to the caller.
  if (owned.length >= 0xffff) throw new Error('Evidence archive exceeds the supported entry count');
  for (const [path] of owned) validateEvidencePath({ path });
  const directory = createMemoryZipCentralDirectoryStore();
  const chunks: Blob[] = [];
  const writer = new StreamingZipWriter({
    output: {
      async write({ chunk }) {
        chunks.push(new Blob([Uint8Array.from(chunk)]));
      },
    },
    centralDirectoryStore: directory,
    compressionCodec: createWebZipCompressionCodec(),
  });
  try {
    for (const [path, content] of owned) {
      await writer.addFile({
        name: path, stream: content.stream(), compression: 'deflate',
        // Evidence timestamps live in JSON. Container metadata must not change
        // when the same retained files are exported again.
        modifiedAt: new Date(1980, 0, 1),
      });
    }
    await writer.finalize();
    return new Blob(chunks, { type: 'application/zip' });
  } finally {
    await directory.dispose();
  }
}

/** Index once, decode one requested entry at a time, and retain no decoded body. */
export async function openEvidenceArchive({ blob }: { blob: Blob }): Promise<{
  reader: EvidenceArchiveReader; close(): Promise<void>;
}> {
  const zip = new StreamingZipReader({
    source: createBlobZipSource({ blob }), compressionCodec: createWebZipCompressionCodec(),
  });
  let closed = false;
  try {
    const entries = new Map<string, ZipArchiveEntry>();
    for await (const entry of zip.entries()) {
      if (entry.isDirectory) continue;
      validateEvidencePath({ path: entry.name });
      if (entry.isSymbolicLink || entries.has(entry.name)) throw new Error('Duplicate or unsupported Evidence archive entry');
      entries.set(entry.name, entry);
    }
    return {
      reader: {
        paths: [...entries.keys()],
        async read({ path }) {
          if (closed) throw new Error('Evidence archive reader is closed');
          const entry = entries.get(path);
          if (entry === undefined) return undefined;
          const parts: Blob[] = [];
          for await (const chunk of iterateZipStreamChunks({ stream: await zip.openEntry({ entry }) })) {
            parts.push(new Blob([Uint8Array.from(chunk)]));
          }
          return new Blob(parts);
        },
      },
      async close() {
        closed = true;
        entries.clear();
        await zip.close();
      },
    };
  } catch (error) {
    await zip.close();
    throw error;
  }
}

export const TEST_ONLY = {
};
