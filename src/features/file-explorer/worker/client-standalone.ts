import * as Comlink from 'comlink';

import { createFileProtocolStandaloneWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub-standalone-loader';
import { createNaidanSysfsRemoteReaderForMounts } from '@/features/wesh/naidan-sysfs/storage-reader';
import {
  fileExplorerCreateDirectoryArchiveResponseSchema,
  fileExplorerAnalyzeZipUploadResponseSchema,
  fileExplorerExecuteZipUploadResponseSchema,
  fileExplorerReadZipUploadPreviewDirectoryResponseSchema,
  fileExplorerSuggestArchiveExclusionsResponseSchema,
  toPlainFileExplorerZipUploadPlacement,
  fileExplorerPrepareSessionResponseSchema,
  fileExplorerReadDirectoryResponseSchema,
  fileExplorerReadFileResponseSchema,
  fileExplorerReadPreviewResponseSchema,
  type FileExplorerRootDescriptor,
  type FileExplorerWorkerClient,
  type IFileExplorerWorker,
} from './types';
import type { IWorkerHub } from '@/features/file-protocol-standalone/worker/worker-hub.types';

function createDirectoryArchiveJobId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `file-explorer-directory-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}


function createZipUploadJobId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `file-explorer-zip-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
  const worker = await createFileProtocolStandaloneWorkerHub();
  const remote = Comlink.wrap<IWorkerHub>(worker);
  const fileExplorer = await remote.fileExplorer as Comlink.Remote<IFileExplorerWorker>;
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
  const prepareResponse = await fileExplorer.prepareSession({
    request: {
      root: requestRoot,
    },
  });
  const sessionId = fileExplorerPrepareSessionResponseSchema.parse(prepareResponse).sessionId;

  return {
    async readDirectory({ path }) {
      return fileExplorerReadDirectoryResponseSchema.parse(
        await fileExplorer.readDirectory({ request: { sessionId, path } }),
      );
    },
    async readPreview({ path, mode }) {
      return fileExplorerReadPreviewResponseSchema.parse(
        await fileExplorer.readPreview({ request: { sessionId, path, mode } }),
      );
    },
    async readFile({ path }) {
      return fileExplorerReadFileResponseSchema.parse(
        await fileExplorer.readFile({ request: { sessionId, path } }),
      );
    },
    async suggestArchiveExclusions({ directoryPath, query, excludedRelativePaths }) {
      return fileExplorerSuggestArchiveExclusionsResponseSchema.parse(
        await fileExplorer.suggestArchiveExclusions({
          request: { sessionId, directoryPath, query, excludedRelativePaths },
        }),
      );
    },
    startDirectoryArchive({ directoryPath, excludedRelativePaths }) {
      const jobId = createDirectoryArchiveJobId();
      return {
        result: fileExplorer.createDirectoryArchive({
          request: { sessionId, jobId, directoryPath, excludedRelativePaths },
        }).then(response => fileExplorerCreateDirectoryArchiveResponseSchema.parse(response)),
        async cancel() {
          await fileExplorer.cancelDirectoryArchive({ request: { sessionId, jobId } });
        },
      };
    },
    async createFile({ parentPath, name }) {
      await fileExplorer.createFile({ request: { sessionId, parentPath, name } });
    },
    async createFolder({ parentPath, name }) {
      await fileExplorer.createFolder({ request: { sessionId, parentPath, name } });
    },
    async deleteEntries({ paths }) {
      await fileExplorer.deleteEntries({ request: { sessionId, paths } });
    },
    async renameEntry({ path, newName }) {
      await fileExplorer.renameEntry({ request: { sessionId, path, newName } });
    },
    async copyEntries({ sourcePaths, targetDirectoryPath }) {
      await fileExplorer.copyEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } });
    },
    async moveEntries({ sourcePaths, targetDirectoryPath }) {
      await fileExplorer.moveEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } });
    },
    async analyzeZipUpload({ analysisId, targetDirectoryPath, fileName, blob }) {
      return fileExplorerAnalyzeZipUploadResponseSchema.parse(
        await fileExplorer.analyzeZipUpload({
          request: { sessionId, analysisId, targetDirectoryPath, fileName, blob },
        }),
      );
    },
    async readZipUploadPreviewDirectory({ analysisId, placement, relativePath }) {
      const plainPlacement = toPlainFileExplorerZipUploadPlacement({ placement });
      return fileExplorerReadZipUploadPreviewDirectoryResponseSchema.parse(
        await fileExplorer.readZipUploadPreviewDirectory({
          request: { sessionId, analysisId, placement: plainPlacement, relativePath },
        }),
      );
    },
    startZipUpload({ analysisId, placement }) {
      const jobId = createZipUploadJobId();
      const plainPlacement = toPlainFileExplorerZipUploadPlacement({ placement });
      return {
        result: fileExplorer.executeZipUpload({
          request: { sessionId, analysisId, jobId, placement: plainPlacement },
        }).then(response => fileExplorerExecuteZipUploadResponseSchema.parse(response)),
        async cancel() {
          await fileExplorer.cancelZipUpload({ request: { sessionId, jobId } });
        },
      };
    },
    async disposeZipUploadAnalysis({ analysisId }) {
      await fileExplorer.disposeZipUploadAnalysis({ request: { sessionId, analysisId } });
    },
    async uploadFiles({ targetDirectoryPath, files }) {
      await fileExplorer.uploadFiles({ request: { sessionId, targetDirectoryPath, files } });
    },
    async dispose() {
      try {
        await fileExplorer.disposeSession({ request: { sessionId } });
        await remote[Comlink.releaseProxy]();
      } finally {
        worker.terminate();
      }
    },
  };
}
