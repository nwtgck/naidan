import * as Comlink from 'comlink';

import { createNaidanSysfsRemoteReaderForMounts } from '@/services/wesh/naidan-sysfs/storage-reader';
import {
  fileExplorerPrepareSessionResponseSchema,
  fileExplorerReadDirectoryResponseSchema,
  fileExplorerReadFileResponseSchema,
  fileExplorerReadPreviewResponseSchema,
  type FileExplorerRootDescriptor,
  type FileExplorerWorkerClient,
  type IFileExplorerWorker,
} from './types';

export async function createFileExplorerWorkerClient({
  root,
}: {
  root: FileExplorerRootDescriptor,
}): Promise<FileExplorerWorkerClient> {
  const naidanSysfsRemoteReader = (() => {
    switch (root.kind) {
    case 'native-directory':
    case 'opfs-root':
      return undefined;
    case 'wesh-mounts':
      return createNaidanSysfsRemoteReaderForMounts({ mounts: root.mounts });
    default: {
      const _ex: never = root;
      throw new Error(`Unhandled file explorer root kind: ${String(_ex)}`);
    }
    }
  })();
  const worker = new Worker(
    new URL('./entry.ts', import.meta.url),
    {
      type: 'module',
      name: 'naidan-file-explorer-worker',
    },
  );
  const remote = Comlink.wrap<IFileExplorerWorker>(worker);
  const requestRoot = (() => {
    switch (root.kind) {
    case 'native-directory':
    case 'opfs-root':
      return root;
    case 'wesh-mounts':
      return {
        ...root,
        naidanSysfsRemoteReader: naidanSysfsRemoteReader
          ? Comlink.proxy(naidanSysfsRemoteReader)
          : undefined,
      };
    default: {
      const _ex: never = root;
      throw new Error(`Unhandled file explorer root kind: ${String(_ex)}`);
    }
    }
  })();
  const prepareResponse = await remote.prepareSession({
    request: {
      root: requestRoot,
    },
  });
  const sessionId = fileExplorerPrepareSessionResponseSchema.parse(prepareResponse).sessionId;

  return {
    async readDirectory({ path }) {
      return fileExplorerReadDirectoryResponseSchema.parse(
        await remote.readDirectory({ request: { sessionId, path } }),
      );
    },
    async readPreview({ path, mode }) {
      return fileExplorerReadPreviewResponseSchema.parse(
        await remote.readPreview({ request: { sessionId, path, mode } }),
      );
    },
    async readFile({ path }) {
      return fileExplorerReadFileResponseSchema.parse(
        await remote.readFile({ request: { sessionId, path } }),
      );
    },
    async createFile({ parentPath, name }) {
      await remote.createFile({ request: { sessionId, parentPath, name } });
    },
    async createFolder({ parentPath, name }) {
      await remote.createFolder({ request: { sessionId, parentPath, name } });
    },
    async deleteEntries({ paths }) {
      await remote.deleteEntries({ request: { sessionId, paths } });
    },
    async renameEntry({ path, newName }) {
      await remote.renameEntry({ request: { sessionId, path, newName } });
    },
    async copyEntries({ sourcePaths, targetDirectoryPath }) {
      await remote.copyEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } });
    },
    async moveEntries({ sourcePaths, targetDirectoryPath }) {
      await remote.moveEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } });
    },
    async uploadFiles({ targetDirectoryPath, files }) {
      await remote.uploadFiles({ request: { sessionId, targetDirectoryPath, files } });
    },
    async dispose() {
      try {
        await remote.disposeSession({ request: { sessionId } });
        await remote[Comlink.releaseProxy]();
      } finally {
        worker.terminate();
      }
    },
  };
}
