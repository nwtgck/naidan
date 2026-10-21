import { z } from 'zod';
import { temporaryFilePathSchema, temporaryRootNameSchema, type TemporaryModelDirectory, type TemporaryModelDirectoryInput } from '@/01-models/temporary-model-files';

const fileSchema = z.custom<File>(value => typeof File !== 'undefined' && value instanceof File && Number.isSafeInteger(value.size) && value.size >= 0);

/** Page-local directory ownership, independent of any model format or Worker.
 * Only references are retained; no model bytes, handles or DTOs are written. */
export function createTemporaryModelFiles() {
  const roots = new Map<string, TemporaryModelDirectory>();
  const listeners = new Set<({ rootId }: { rootId: string }) => void>();
  let revision = 0;
  function notify({ rootId }: { rootId: string }): void {
    for (const listener of listeners) {
      try {
        listener({ rootId });
      } catch { /* An observer cannot roll back a committed file registration. */ }
    }
  }
  function register({ directory, signal }: { directory: TemporaryModelDirectoryInput, signal: AbortSignal | undefined }): TemporaryModelDirectory {
    signal?.throwIfAborted();
    const name = temporaryRootNameSchema.parse(directory.name.replaceAll(':', '_'));
    if (!directory.files.length || directory.files.length > 20_000) {
      throw new Error('A temporary model folder must contain between 1 and 20000 files');
    }
    const paths = new Set<string>();
    const files = directory.files.map(({ path, file, ...unhandled }) => {
      unhandled satisfies Record<PropertyKey, never>;
      temporaryFilePathSchema.parse(`temp/${name}/${path}`);
      if (paths.has(path) || path.split('/').includes('.git')) {
        throw new Error('Duplicate or reserved path in temporary model folder');
      }
      paths.add(path);
      // Local publication receipts/markers are opaque files, not authority.
      // Keeping them allows a downloaded linked-folder tree to be reused here;
      // unlike an OPFS import, no marker is replayed or written into storage.
      return Object.freeze({ path, file: fileSchema.parse(file) });
    });
    if (!Number.isSafeInteger(files.reduce((total, entry) => total + entry.file.size, 0))) {
      throw new Error('Temporary model folder size exceeds the safe integer range');
    }
    for (const path of paths) {
      const parts = path.split('/');
      parts.pop();
      while (parts.length) {
        if (paths.has(parts.join('/'))) {
          throw new Error('A temporary model path is both a file and a folder');
        }
        parts.pop();
      }
    }
    signal?.throwIfAborted();
    // Validate first, then reserve synchronously: concurrent drops cannot publish
    // the same name. Only live roots reserve names; removal permits immediate reuse.
    let available = name;
    for (let suffix = 2; roots.has(`temp/${available}`); suffix++) {
      const ending = `-${suffix}`;
      const characters = Array.from(name);
      while (new TextEncoder().encode(characters.join('') + ending).length > 255) {
        characters.pop();
      }
      available = characters.join('') + ending;
    }
    const root = Object.freeze({ id: `temp/${available}`, name: available, sourceName: name, revision: ++revision, files: Object.freeze(files) });
    roots.set(root.id, root);
    notify({ rootId: root.id });
    return root;
  }
  return {
    register,
    list(): readonly TemporaryModelDirectory[] {
      return [...roots.values()];
    },
    get({ rootId }: { rootId: string }): TemporaryModelDirectory | undefined {
      return roots.get(rootId);
    },
    remove({ rootId }: { rootId: string }): void {
      if (roots.delete(rootId)) {
        notify({ rootId });
      }
    },
    subscribe({ listener }: { listener: ({ rootId }: { rootId: string }) => void }): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type TemporaryModelFiles = ReturnType<typeof createTemporaryModelFiles>;
export const temporaryModelFiles = createTemporaryModelFiles();

export const TEST_ONLY = {
};
