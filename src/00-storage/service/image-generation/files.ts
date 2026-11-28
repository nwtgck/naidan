import type { FileLocation } from '@/00-format/file-record';
import type { ImageGenerationIo } from '@/00-format/image-generation-record';

export function imageGenerationIsNotFound({ error }: { error: unknown }): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'NotFoundError';
}

export async function imageGenerationDirectory({ parent, name, create }: {
  parent: FileSystemDirectoryHandle, name: string, create: boolean,
}): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch (error) {
    if (!create && imageGenerationIsNotFound({ error })) {
      return undefined;
    }
    throw error;
  }
}

async function readImageGenerationText({ directory, name, sizeLimit }: { directory: FileSystemDirectoryHandle, name: string, sizeLimit: number | undefined }): Promise<string | undefined> {
  let handle: FileSystemFileHandle;
  try {
    handle = await directory.getFileHandle(name);
  } catch (error) {
    if (imageGenerationIsNotFound({ error })) {
      return undefined;
    }
    throw error;
  }
  const file = await handle.getFile();
  if (sizeLimit !== undefined && file.size > sizeLimit) {
    throw new Error(`Image Generation metadata exceeds the read limit: ${name}`);
  }
  return file.text();
}

async function writeImageGenerationText({ directory, name, text, sizeLimit }: { directory: FileSystemDirectoryHandle, name: string, text: string, sizeLimit: number | undefined }): Promise<void> {
  if (sizeLimit !== undefined && new TextEncoder().encode(text).byteLength > sizeLimit) {
    throw new Error('Image Generation metadata exceeds the write limit.');
  }
  let handle: FileSystemFileHandle;
  let created = false;
  try {
    handle = await directory.getFileHandle(name);
  } catch (error) {
    if (!imageGenerationIsNotFound({ error })) {
      throw error;
    }
    handle = await directory.getFileHandle(name, { create: true });
    created = true;
  }
  let writable: FileSystemWritableFileStream | undefined;
  try {
    writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  } catch (error) {
    try {
      await writable?.abort();
    } catch { /* Keep the original failure. */ }
    if (created) {
      try {
        await directory.removeEntry(name);
      } catch { /* Preserve unreadable bytes for raw export if cleanup fails. */ }
    }
    throw error;
  }
}

export function imageGenerationIo({ directory, path }: {
  directory: FileSystemDirectoryHandle, path: readonly string[],
}): ImageGenerationIo {
  async function openDirectory({ path: target, create }: {
    path: readonly string[], create: boolean,
  }): Promise<FileSystemDirectoryHandle | undefined> {
    if (path.length > target.length || !path.every((segment, index) => segment === target[index])) {
      throw new Error('Image Generation record path is outside the storage directory.');
    }
    let current = directory;
    for (const name of target.slice(path.length)) {
      const next = await imageGenerationDirectory({ parent: current, name, create });
      if (next === undefined) {
        return undefined;
      }
      current = next;
    }
    return current;
  }

  function openParent({ file, create }: { file: FileLocation, create: boolean }) {
    return openDirectory({ path: file.path.slice(0, -1), create });
  }

  return {
    async open({ location, create, allowMissing }) {
      try {
        const handle = await openDirectory({ path: location.path, create });
        return handle && imageGenerationIo({ directory: handle, path: location.path });
      } catch (error) {
        if (allowMissing && imageGenerationIsNotFound({ error })) {
          return undefined;
        }
        throw error;
      }
    },
    async *entries() {
      for await (const [name, handle] of directory.entries()) {
        switch (handle.kind) {
        case 'file':
          yield { name, kind: 'file' };
          break;
        case 'directory':
          yield { name, kind: 'directory', directory: () => imageGenerationIo({ directory: handle, path: [...path, name] }) };
          break;
        default: {
          const exhaustive: never = handle;
          throw new Error(String(exhaustive));
        }
        }
      }
    },
    async readText({ file }) {
      const parent = await openParent({ file, create: false });
      return parent && readImageGenerationText({ directory: parent, name: file.name, sizeLimit: file.maxBytes });
    },
    async writeText({ file, text }) {
      const parent = (await openParent({ file, create: true }))!;
      await writeImageGenerationText({ directory: parent, name: file.name, text, sizeLimit: file.maxBytes });
    },
    async readFile({ file }) {
      const parent = await openParent({ file, create: false });
      if (!parent) {
        return undefined;
      }
      let handle: FileSystemFileHandle;
      try {
        handle = await parent.getFileHandle(file.name);
      } catch (error) {
        if (imageGenerationIsNotFound({ error })) {
          return undefined;
        }
        throw error;
      }
      return handle.getFile();
    },
    async remove({ location, recursive }) {
      const parent = await openParent({ file: location, create: false });
      if (!parent) {
        throw new DOMException('Image Generation directory is missing.', 'NotFoundError');
      }
      await parent.removeEntry(location.name, recursive ? { recursive: true } : undefined);
    },
    async removeEmptyDirectory({ location }) {
      const parent = await openParent({ file: location, create: false });
      if (!parent) {
        return;
      }
      const handle = await parent.getDirectoryHandle(location.name);
      for await (const _entry of handle.entries()) {
        return;
      }
      await parent.removeEntry(location.name);
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
