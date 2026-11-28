import { opfsFormat } from '@/00-format/01-layout/layout';

/** History only locates runtime-owned output folders. It must never resolve a
 * user-supplied path into settings or create a replacement for expired results.
 */
function check({ path }: { path: string[] }): void {
  if (!opfsFormat.tmp.workflowResults.matchesPath({ path })) {
    throw new Error('Invalid temporary Workflow result path.');
  }
}

export async function workflowResultsPath({ root, directory }: { root: FileSystemDirectoryHandle, directory: FileSystemDirectoryHandle }): Promise<string[]> {
  const path = await root.resolve(directory);
  if (path === null) {
    throw new Error('Workflow result folder is outside OPFS.');
  }
  check({ path });
  return path;
}

export async function openWorkflowHistoryResults({ root, path }: { root: FileSystemDirectoryHandle, path: string[] }): Promise<FileSystemDirectoryHandle | undefined> {
  check({ path });
  let directory = root;
  try {
    for (const segment of path) {
      directory = await directory.getDirectoryHandle(segment);
    }
    return directory;
  } catch (error) {
    if ((error instanceof Error || error instanceof DOMException) && error.name === 'NotFoundError') {
      return undefined;
    }
    throw error;
  }
}

export const TEST_ONLY = {
};
