/** Opens a path relative to the supplied directory. */
export async function openDirectoryPath({ root, path, create, signal }: {
  root: FileSystemDirectoryHandle,
  path: readonly string[],
  create: boolean | undefined,
  signal?: AbortSignal,
}): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const segment of path) {
    current = create === undefined
      ? await current.getDirectoryHandle(segment)
      : await current.getDirectoryHandle(segment, { create });
    signal?.throwIfAborted();
  }
  return current;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
