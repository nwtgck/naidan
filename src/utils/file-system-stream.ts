export function isFileSystemEntryLookupMiss({ error }: { error: unknown }): boolean {
  if (error instanceof DOMException) {
    return error.name === 'NotFoundError' || error.name === 'TypeMismatchError';
  }
  if (error instanceof Error) {
    return error.message.startsWith('NotFoundError:')
      || error.message.startsWith('TypeMismatchError:');
  }
  return false;
}

export async function writeReadableStreamToFileHandle({
  source,
  targetHandle,
  signal,
}: {
  source: ReadableStream<Uint8Array>,
  targetHandle: FileSystemFileHandle,
  signal: AbortSignal | undefined,
}): Promise<void> {
  signal?.throwIfAborted();
  const reader = source.getReader();
  let writable: FileSystemWritableFileStream | undefined;
  let sourceCompleted = false;

  try {
    writable = await (targetHandle as unknown as {
      createWritable: () => Promise<FileSystemWritableFileStream>,
    }).createWritable();
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) {
        sourceCompleted = true;
        break;
      }
      await writable.write(Uint8Array.from(result.value).buffer);
    }
    await writable.close();
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // Preserve the original read, open, or write error.
    }
    if (writable !== undefined) {
      try {
        await writable.abort(error);
      } catch {
        // Preserve the original read, open, or write error.
      }
    }
    throw error;
  } finally {
    if (!sourceCompleted) {
      try {
        await reader.cancel();
      } catch {
        // Cleanup is best effort.
      }
    }
    reader.releaseLock();
  }
}

export async function copyFileSystemFileHandle({
  sourceHandle,
  targetHandle,
  signal,
}: {
  sourceHandle: FileSystemFileHandle,
  targetHandle: FileSystemFileHandle,
  signal: AbortSignal | undefined,
}): Promise<void> {
  const sourceFile = await sourceHandle.getFile();
  await writeReadableStreamToFileHandle({
    source: sourceFile.stream(),
    targetHandle,
    signal,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
