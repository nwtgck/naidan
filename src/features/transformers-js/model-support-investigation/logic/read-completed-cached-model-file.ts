function isNotFoundError({ error }: { error: unknown }): boolean {
  return error instanceof DOMException
    ? error.name === "NotFoundError"
    : error instanceof Error && error.name === "NotFoundError";
}

export async function readCompletedCachedModelFile({
  storageRoot,
  normalizedModelId,
  revision,
  repositoryPath,
}: {
  storageRoot: FileSystemDirectoryHandle,
  normalizedModelId: string,
  revision: string,
  repositoryPath: string,
}): Promise<Uint8Array | undefined> {
  const pathParts = [
    "models",
    "huggingface.co",
    ...normalizedModelId.split("/"),
    "resolve",
    revision,
    ...repositoryPath.split("/"),
  ];
  const fileName = pathParts.pop();
  if (fileName === undefined || fileName.length === 0) return undefined;

  try {
    let directory = storageRoot;
    for (const part of pathParts) {
      if (part.length === 0) continue;
      directory = await directory.getDirectoryHandle(part, { create: false });
    }
    await directory.getFileHandle(`.${fileName}.complete`, { create: false });
    const file = await (await directory.getFileHandle(fileName, { create: false })).getFile();
    if (file.size === 0) return undefined;
    return new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (isNotFoundError({ error })) return undefined;
    throw error;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
