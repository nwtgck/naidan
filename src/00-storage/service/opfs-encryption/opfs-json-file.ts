import type { ZodType } from 'zod';

interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>,
}

export async function readJsonFileIfPresent<T>({
  directory,
  name,
  schema,
}: {
  directory: FileSystemDirectoryHandle,
  name: string,
  schema: ZodType<T>,
}): Promise<T | undefined> {
  try {
    const handle = await directory.getFileHandle(name);
    const file = await handle.getFile();
    return schema.parse(JSON.parse(await file.text()));
  } catch (error) {
    if (isNotFoundError({ error })) {
      return undefined;
    }
    throw error;
  }
}

export async function writeJsonFile({
  directory,
  name,
  value,
}: {
  directory: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
}): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true }) as FileSystemFileHandleWithWritable;
  const writable = await handle.createWritable();
  try {
    await writable.write(JSON.stringify(value));
    await writable.close();
  } catch (error) {
    try {
      await writable.abort(error);
    } catch {
      // Preserve the original serialization or write error.
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
