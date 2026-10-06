import { createSha256Hasher } from '@/features/wesh/commands/sha256sum/sha256';

type ModelFileInput = { key: string; file: File; expectedSha256: string | undefined };
type VerifiedFile = { file: File; sha256: string };
const chunkBytes = 256 * 1024;

/** Fixed slices also bound memory for disk-backed File objects with large producer chunks. */
async function hashFile({ file, signal }: { file: File; signal: AbortSignal }): Promise<string> {
  const hash = createSha256Hasher();
  let yieldedAt = performance.now();
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    signal.throwIfAborted();
    const length = Math.min(chunkBytes, file.size - offset);
    const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    signal.throwIfAborted();
    if (bytes.length !== length) throw new Error('Model file changed during content verification');
    hash.update({ bytes });
    if (performance.now() - yieldedAt >= 40) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      signal.throwIfAborted();
      yieldedAt = performance.now();
    }
  }
  signal.throwIfAborted();
  return hash.digestHex();
}

/** One RPC resource owner, one previous configuration, no persisted identity guesses. */
export function createVerifiedImageModelFiles() {
  let retained = new Map<string, VerifiedFile>();
  return {
    clear(): void {
      retained.clear();
    },
    async prepare({ files, signal }: { files: readonly ModelFileInput[]; signal: AbortSignal }) {
      const next = new Map<string, VerifiedFile>();
      const replacements = new Map<File, File>();
      for (const { key, file, expectedSha256, ...rest } of files) {
        rest satisfies Record<PropertyKey, never>;
        signal.throwIfAborted();
        const duplicate = next.get(key);
        if (duplicate) {
          if (duplicate.file !== replacements.get(file)) throw new Error('Conflicting model file selection');
          continue;
        }
        // Even an unchanged File object may have an externally mutable backing file.
        const sha256 = await hashFile({ file, signal });
        if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw new Error('Published model content does not match its receipt');
        const previous = retained.get(key);
        let selected = file;
        if (previous && previous.sha256 === sha256 && previous.file.size === file.size && previous.file.lastModified === file.lastModified) {
          try {
            // Retained mounts must remain readable, as well as matching the original digest.
            if (previous.file === file || await hashFile({ file: previous.file, signal }) === previous.sha256) selected = previous.file;
          } catch (error) {
            signal.throwIfAborted();
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            // A stale disk snapshot is replaced by the freshly verified File.
          }
        }
        if (previous?.file === file && previous.sha256 !== sha256) {
          // A mutable backing must also change the engine's reference-based session key.
          // Blob slicing keeps this a file-backed value; no whole-file byte array is created.
          selected = new File([file.slice(0, file.size)], file.name, { type: file.type, lastModified: file.lastModified });
        }
        next.set(key, { file: selected, sha256 });
        replacements.set(file, selected);
      }
      signal.throwIfAborted();
      return {
        replacements,
        commit(): void {
          signal.throwIfAborted();
          retained = next;
        },
      };
    },
  };
}

export const TEST_ONLY = {
};
