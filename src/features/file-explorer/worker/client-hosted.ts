import { createWorkerBlobReadHost } from '@/utils/worker-blob-context';
import { runWithFileSystemHandleCloneFallback } from '@/utils/file-system-handle-transport';
import { releaseWorkerRemote, workerCapability, workerProxy, wrapWorkerRemote } from '@/utils/worker-transport';
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
import {
  hasFileExplorerFileSystemHandles,
  mapFileExplorerRootToOpfsLocators,
} from './root-transport';

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
  const createRuntime = async ({ requestRoot }: {
    requestRoot: FileExplorerRootDescriptor,
  }) => {
    const worker = new Worker(
      new URL('./entry.ts', import.meta.url),
      {
        type: 'module',
        name: 'naidan-file-explorer-worker',
      },
    );
    const remote = wrapWorkerRemote<IFileExplorerWorker>({ endpoint: worker });
    const blobReadHostLifetime = new AbortController();
    const blobReadHost = createWorkerBlobReadHost({ signal: blobReadHostLifetime.signal });
    try {
      const prepareResponse = await remote.prepareSession(
        workerCapability({
          value: { request: { root: requestRoot } },
          capability: 'file-system-handle-clone',
        }),
        naidanSysfsRemoteReader
          ? workerProxy({ value: naidanSysfsRemoteReader })
          : undefined,
        workerProxy({ value: blobReadHost }),
      );
      return {
        worker,
        remote,
        sessionId: fileExplorerPrepareSessionResponseSchema.parse(prepareResponse).sessionId,
        blobReadHostLifetime,
      };
    } catch (error) {
      blobReadHostLifetime.abort(error);
      worker.terminate();
      throw error;
    }
  };

  const runtime = hasFileExplorerFileSystemHandles({ root })
    ? await runWithFileSystemHandleCloneFallback({
      direct: () => createRuntime({ requestRoot: root }),
      fallback: async () => createRuntime({
        requestRoot: await mapFileExplorerRootToOpfsLocators({ root }),
      }),
    })
    : await createRuntime({ requestRoot: root });
  const { worker, remote, sessionId, blobReadHostLifetime } = runtime;
  let disposal: Promise<void> | undefined;

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
    dispose() {
      // Concurrent owners must share cleanup; neither may release the remote
      // endpoint or terminate the Worker while writes are still being aborted.
      disposal ??= (async () => {
        try {
          await remote.disposeSession({ request: { sessionId } });
          await releaseWorkerRemote({ remote });
        } finally {
          blobReadHostLifetime.abort(new DOMException('File explorer disposed', 'AbortError'));
          worker.terminate();
        }
      })();
      return disposal;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
