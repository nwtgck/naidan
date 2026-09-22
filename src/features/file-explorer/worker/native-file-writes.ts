import type { BlobContext, BlobView } from '@/utils/blob-view';
import { writeReadableStreamToFileHandle } from '@/utils/file-system-stream';

type NativeEntry = FileSystemFileHandle | FileSystemDirectoryHandle;

interface NativeFileWriter {
  readonly signal: AbortSignal,
  writeFile({ source, targetDirectory, name }: {
    source: BlobView,
    targetDirectory: FileSystemDirectoryHandle,
    name: string,
  }): Promise<void>,
  copyEntry({ source, targetDirectory, name }: {
    source: NativeEntry,
    targetDirectory: FileSystemDirectoryHandle,
    name: string,
  }): Promise<void>,
}

/** A copy operation bound once to its owning context, including ZIP recovery reads. */
export function createNativeFileCopy({ blobs }: { blobs: BlobContext }) {
  return async ({ sourceHandle, targetHandle, signal }: {
    sourceHandle: FileSystemFileHandle,
    targetHandle: FileSystemFileHandle,
    signal: AbortSignal | undefined,
  }): Promise<void> => {
    signal?.throwIfAborted();
    const source = blobs.fromNative({ blob: await sourceHandle.getFile() });
    signal?.throwIfAborted();
    await writeReadableStreamToFileHandle({ source: source.stream({ signal }), targetHandle, signal });
  };
}

/** Borrow one session context. Wrap files at acquisition, not in every copy helper. */
export function createNativeFileWriteScope({ blobs }: { blobs: BlobContext }) {
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const pending = new Set<Promise<void>>();
  let disposal: Promise<void> | undefined;

  async function writeFile({ source, targetDirectory, name }: {
    source: BlobView,
    targetDirectory: FileSystemDirectoryHandle,
    name: string,
  }): Promise<void> {
    signal.throwIfAborted();
    const target = await targetDirectory.getFileHandle(name, { create: true });
    signal.throwIfAborted();
    await writeReadableStreamToFileHandle({ source: source.stream({ signal }), targetHandle: target, signal });
  }

  async function copyTree({ source, targetDirectory, name }: {
    source: NativeEntry,
    targetDirectory: FileSystemDirectoryHandle,
    name: string,
  }): Promise<void> {
    signal.throwIfAborted();
    switch (source.kind) {
    case 'file': {
      // Acquire the immutable source before opening a destination for writing.
      const snapshot = blobs.fromNative({ blob: await source.getFile() });
      signal.throwIfAborted();
      const target = await targetDirectory.getFileHandle(name, { create: true });
      if (await source.isSameEntry(target)) throw new DOMException('Cannot copy a file onto itself', 'InvalidModificationError');
      signal.throwIfAborted();
      await writeReadableStreamToFileHandle({ source: snapshot.stream({ signal }), targetHandle: target, signal });
      break;
    }
    case 'directory': {
      const target = await targetDirectory.getDirectoryHandle(name, { create: true });
      if (await source.isSameEntry(target)) throw new DOMException('Cannot copy a directory onto itself', 'InvalidModificationError');
      signal.throwIfAborted();
      for await (const child of source.values()) {
        switch (child.kind) {
        case 'file':
          await copyTree({ source: child as FileSystemFileHandle, targetDirectory: target, name: child.name });
          break;
        case 'directory':
          await copyTree({ source: child as FileSystemDirectoryHandle, targetDirectory: target, name: child.name });
          break;
        default: {
          throw new Error(`Unhandled native entry: ${((child satisfies never) as { kind: string }).kind}`);
        }
        }
      }
      break;
    }
    default: {
      const _ex: never = source;
      throw new Error(`Unhandled native copy source: ${String(_ex)}`);
    }
    }
    signal.throwIfAborted();
  }

  const writer: NativeFileWriter = {
    signal,
    writeFile,
    async copyEntry({ source, targetDirectory, name }) {
      signal.throwIfAborted();
      switch (source.kind) {
      case 'file':
        break;
      case 'directory': {
        // Validate before creating descendants, so copying into the source cannot
        // start traversing directories created by this very copy operation.
        const same = await source.isSameEntry(targetDirectory);
        const relativePath = await source.resolve(targetDirectory);
        signal.throwIfAborted();
        // Do not rely on [] to distinguish an unrelated handle from the source.
        if (same || (relativePath !== null && relativePath.length > 0)) {
          throw new DOMException('Cannot copy a directory into itself', 'InvalidModificationError');
        }
        break;
      }
      default: {
        const _ex: never = source;
        throw new Error(`Unhandled native copy source: ${String(_ex)}`);
      }
      }
      await copyTree({ source, targetDirectory, name });
    },
  };

  return {
    run({ operation }: { operation: ({ writer }: { writer: NativeFileWriter }) => Promise<void> }): Promise<void> {
      if (signal.aborted) return Promise.reject(signal.reason);
      const result = Promise.resolve().then(async () => {
        signal.throwIfAborted();
        await operation({ writer });
        signal.throwIfAborted();
      });
      // Track cleanup independently from the public success/failure of the job.
      const settled = result.then(() => undefined, () => undefined);
      pending.add(settled);
      void settled.then(() => {
        pending.delete(settled);
      });
      return result;
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal;
      lifetime.abort(new DOMException('File explorer writes disposed', 'AbortError'));
      // Do not race handle acquisition/close: a late handle still needs aborting.
      disposal = Promise.all([...pending]).then(() => undefined);
      return disposal;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
