import type { ReadWorkflowFile } from '@/00-format/workflow-records';

export function workflowFileNotFound({ error }: { error: unknown }): boolean {
  return (error instanceof Error || error instanceof DOMException) && error.name === 'NotFoundError';
}

export function workflowFileReader({ directory }: { directory: FileSystemDirectoryHandle }): ReadWorkflowFile {
  return async ({ file, read }) => {
    try {
      const contents = await (await directory.getFileHandle(file.name)).getFile();
      return await read({ contents });
    } catch (error) {
      if (workflowFileNotFound({ error })) {
        return undefined;
      }
      throw error;
    }
  };
}

export const TEST_ONLY = {
};
