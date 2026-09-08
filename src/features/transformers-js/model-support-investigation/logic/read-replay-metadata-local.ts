export async function readReplayMetadataLocal({ storageRoot, modelId, revision, path }: {
  storageRoot: FileSystemDirectoryHandle,
  modelId: string,
  revision: string,
  path: string,
}): Promise<Blob | undefined> {
  try {
    let directory = storageRoot;
    for (const part of ['models', 'huggingface.co', ...modelId.split('/'), 'resolve', revision]) {
      directory = await directory.getDirectoryHandle(part, { create: false });
    }
    await directory.getFileHandle(`.${path}.complete`, { create: false });
    // getFile obtains a snapshot/size; bytes are streamed only after the collector's budget check.
    return await (await directory.getFileHandle(path, { create: false })).getFile();
  } catch (error) {
    if ((error instanceof DOMException || error instanceof Error) && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
