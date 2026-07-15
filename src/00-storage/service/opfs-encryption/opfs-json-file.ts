import type { ZodType } from 'zod';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

export class OpfsJsonSyntaxError extends Error {
  constructor({ name, cause }: {
    name: string;
    cause: unknown;
  }) {
    super(`OPFS JSON file is syntactically invalid: ${name}`, { cause });
    this.name = 'OpfsJsonSyntaxError';
  }
}

export async function readJsonValueIfPresent({
  directory,
  name,
}: {
  directory: FileSystemDirectoryHandle;
  name: string;
}): Promise<unknown | undefined> {
  let text: string;
  try {
    const handle = await directory.getFileHandle(name);
    const file = await handle.getFile();
    text = await file.text();
  } catch (error) {
    if (isNotFoundError({ error })) {
      return undefined;
    }
    throw error;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new OpfsJsonSyntaxError({ name, cause: error });
  }
}

export async function readJsonFileIfPresent<T>({
  directory,
  name,
  schema,
}: {
  directory: FileSystemDirectoryHandle;
  name: string;
  schema: ZodType<T>;
}): Promise<T | undefined> {
  const value = await readJsonValueIfPresent({ directory, name });
  return value === undefined ? undefined : schema.parse(value);
}

export async function writeJsonFile({
  directory,
  name,
  value,
}: {
  directory: FileSystemDirectoryHandle;
  name: string;
  value: unknown;
}): Promise<void> {
  const serialized = JSON.stringify(value);
  const handle = await directory.getFileHandle(
    name,
    { create: true },
  ) as FileSystemFileHandleWithWritable;
  const writable = await handle.createWritable();
  try {
    await writable.write(serialized);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort(error);
    } catch {
      // Preserve the original serialization or write error.
    }
    try {
      if (await (await handle.getFile()).text() === serialized) {
        // Treat an exact durable read-back as success even when close reported
        // an error. This prevents state/header writers from rolling back after
        // OPFS already committed the requested slot replacement.
        return;
      }
    } catch {
      // Preserve the original write error when durable completion cannot be
      // proven by an exact read-back.
    }
    throw error;
  }
}

export async function removeDirectoryEntryIfPresent({
  directory,
  name,
}: {
  directory: FileSystemDirectoryHandle;
  name: string;
}): Promise<void> {
  try {
    await directory.removeEntry(name, { recursive: true });
  } catch (error) {
    if (isNotFoundError({ error })) {
      return;
    }
    try {
      await directory.getDirectoryHandle(name);
    } catch (verificationError) {
      if (isNotFoundError({ error: verificationError })) {
        // A recursive directory removal may be durable even when its Promise
        // rejects. The absent postcondition is authoritative for idempotent
        // transition cleanup and prevents reporting failure after commit.
        return;
      }
    }
    throw error;
  }
}

export function isNotFoundError({ error }: { error: unknown }): boolean {
  if (error instanceof DOMException) {
    return error.name === 'NotFoundError';
  }
  return error instanceof Error && error.name === 'NotFoundError';
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
