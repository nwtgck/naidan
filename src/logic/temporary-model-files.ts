import { z } from 'zod';
import { temporaryFilePathSchema, temporaryRootNameSchema, type TemporaryModelDirectory, type TemporaryModelDirectoryInput } from '@/01-models/temporary-model-files';

const fileSchema = z.custom<File>(value => typeof File !== 'undefined' && value instanceof File && Number.isSafeInteger(value.size) && value.size >= 0);

/** Page-local directory ownership, independent of any model format or Worker.
 * Only references are retained; no model bytes, handles or DTOs are written. */
export function createTemporaryModelFiles() {
  const roots = new Map<string, TemporaryModelDirectory>();
  const listeners = new Set<({ rootPath }: { rootPath: string }) => void>();
  let revision = 0;
  function notify({ rootPath }: { rootPath: string }): void {
    for (const listener of listeners) {
      try {
        listener({ rootPath });
      } catch { /* An observer cannot roll back a committed file registration. */ }
    }
  }
  function register({ directory, signal }: { directory: TemporaryModelDirectoryInput, signal: AbortSignal | undefined }): TemporaryModelDirectory {
    signal?.throwIfAborted();
    const name = temporaryRootNameSchema.parse(directory.rootName.replaceAll(':', '_'));
    if (!directory.files.length || directory.files.length > 20_000) {
      throw new Error('A temporary model folder must contain between 1 and 20000 files');
    }
    const paths = new Set<string>();
    const files = directory.files.map(({ relativePath, file, ...unhandled }) => {
      unhandled satisfies Record<PropertyKey, never>;
      temporaryFilePathSchema.parse(`temp/${name}/${relativePath}`);
      if (paths.has(relativePath) || relativePath.split('/').includes('.git')) {
        throw new Error('Duplicate or reserved path in temporary model folder');
      }
      paths.add(relativePath);
      // Local publication receipts/markers are opaque files, not authority.
      // Keeping them allows a downloaded linked-folder tree to be reused here;
      // unlike an OPFS import, no marker is replayed or written into storage.
      return Object.freeze({ relativePath, file: fileSchema.parse(file) });
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
    const root = Object.freeze({ rootPath: `temp/${available}`, rootName: available, sourceRootName: name, registrationRevision: ++revision, files: Object.freeze(files) });
    roots.set(root.rootPath, root);
    notify({ rootPath: root.rootPath });
    return root;
  }
  return {
    register,
    list(): readonly TemporaryModelDirectory[] {
      return [...roots.values()];
    },
    get({ rootPath }: { rootPath: string }): TemporaryModelDirectory | undefined {
      return roots.get(rootPath);
    },
    remove({ rootPath }: { rootPath: string }): void {
      if (roots.delete(rootPath)) {
        notify({ rootPath });
      }
    },
    subscribe({ listener }: { listener: ({ rootPath }: { rootPath: string }) => void }): () => void {
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
