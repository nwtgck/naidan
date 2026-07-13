import * as Comlink from 'comlink';

import { createNaidanSysfsRemoteReaderForMounts } from '@/features/wesh/naidan-sysfs/storage-reader';
import { createWeshStorageDirectoryRemoteForMounts } from '@/features/wesh/storage-directory/remote';
import { mapWeshMountsToWorkerMounts } from '@/features/wesh/worker/types';
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
    case 'storage-directory':
      return undefined;
    case 'wesh-mounts':
      return createNaidanSysfsRemoteReaderForMounts({ mounts: root.mounts });
    default: {
      const _ex: never = root;
      throw new Error(`Unhandled file explorer root kind: ${String(_ex)}`);
    }
    }
  })();
  const storageDirectoryRemote = (() => {
    switch (root.kind) {
    case 'native-directory':
    case 'opfs-root':
      return undefined;
    case 'storage-directory':
      return createWeshStorageDirectoryRemoteForMounts({
        mounts: [{
          type: 'storage_directory',
          path: '/',
          handle: root.handle,
          readOnly: root.readOnly,
        }],
      });
    case 'wesh-mounts':
      return createWeshStorageDirectoryRemoteForMounts({ mounts: root.mounts });
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
    case 'storage-directory':
      return {
        kind: 'storage-directory' as const,
        rootName: root.rootName,
        readOnly: root.readOnly,
      };
    case 'wesh-mounts':
      return {
        kind: 'wesh-mounts' as const,
        rootName: root.rootName,
        mounts: mapWeshMountsToWorkerMounts({ mounts: root.mounts }),
      };
    default: {
      const _ex: never = root;
      throw new Error(`Unhandled file explorer root kind: ${String(_ex)}`);
    }
    }
  })();
  const prepareResponse = await remote.prepareSession(
    { root: requestRoot },
    naidanSysfsRemoteReader
      ? Comlink.proxy(naidanSysfsRemoteReader)
      : undefined,
    storageDirectoryRemote
      ? Comlink.proxy(storageDirectoryRemote)
      : undefined,
  );
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
    async suggestArchiveExclusions({ directoryPath, query, excludedRelativePaths }) {
      return fileExplorerSuggestArchiveExclusionsResponseSchema.parse(
        await remote.suggestArchiveExclusions({
          request: { sessionId, directoryPath, query, excludedRelativePaths },
        }),
      );
    },
    startDirectoryArchive({ directoryPath, excludedRelativePaths }) {
      const jobId = createDirectoryArchiveJobId();
      return {
        result: remote.createDirectoryArchive({
          request: { sessionId, jobId, directoryPath, excludedRelativePaths },
        }).then(response => fileExplorerCreateDirectoryArchiveResponseSchema.parse(response)),
        async cancel() {
          await remote.cancelDirectoryArchive({ request: { sessionId, jobId } });
        },
      };
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
    async analyzeZipUpload({ analysisId, targetDirectoryPath, fileName, blob }) {
      return fileExplorerAnalyzeZipUploadResponseSchema.parse(
        await remote.analyzeZipUpload({
          request: { sessionId, analysisId, targetDirectoryPath, fileName, blob },
        }),
      );
    },
    async readZipUploadPreviewDirectory({ analysisId, placement, relativePath }) {
      const plainPlacement = toPlainFileExplorerZipUploadPlacement({ placement });
      return fileExplorerReadZipUploadPreviewDirectoryResponseSchema.parse(
        await remote.readZipUploadPreviewDirectory({
          request: { sessionId, analysisId, placement: plainPlacement, relativePath },
        }),
      );
    },
    startZipUpload({ analysisId, placement }) {
      const jobId = createZipUploadJobId();
      const plainPlacement = toPlainFileExplorerZipUploadPlacement({ placement });
      return {
        result: remote.executeZipUpload({
          request: { sessionId, analysisId, jobId, placement: plainPlacement },
        }).then(response => fileExplorerExecuteZipUploadResponseSchema.parse(response)),
        async cancel() {
          await remote.cancelZipUpload({ request: { sessionId, jobId } });
        },
      };
    },
    async disposeZipUploadAnalysis({ analysisId }) {
      await remote.disposeZipUploadAnalysis({ request: { sessionId, analysisId } });
    },
    async uploadFiles({ targetDirectoryPath, files }) {
      await remote.uploadFiles({ request: { sessionId, targetDirectoryPath, files } });
    },
    async dispose() {
      try {
        await remote.disposeSession({ request: { sessionId } });
        await storageDirectoryRemote?.dispose();
      } finally {
        try {
          await remote[Comlink.releaseProxy]();
        } finally {
          worker.terminate();
        }
      }
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
