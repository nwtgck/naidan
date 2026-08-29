import { runWithFileSystemHandleCloneFallback } from '@/utils/file-system-handle-transport';
import { workerCapability, workerProxy } from '@/utils/worker-transport';
import { createStandaloneWorker } from 'virtual:file-protocol-standalone/worker/file-explorer';
import {
  createStandaloneWorkerSession,
  disposeStandaloneWorkerSession,
  STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
} from '@/features/file-protocol-standalone/worker/standalone-worker-session';
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
  type FileExplorerPrepareSessionRequest,
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
  const requestRoot = await (async () => {
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
        mounts: await mapWeshMountsToWorkerMounts({
          mounts: root.mounts,
          storageDirectoryExecution: 'ui_remote',
        }),
      };
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
        storageDirectoryExecution: 'ui_remote',
      });
    case 'wesh-mounts':
      return createWeshStorageDirectoryRemoteForMounts({
        mounts: root.mounts,
        storageDirectoryExecution: 'ui_remote',
      });
    default: {
      const _ex: never = root;
      throw new Error(`Unhandled file explorer root kind: ${String(_ex)}`);
    }
    }
  })();
  const createRuntime = async ({ requestRoot }: {
    requestRoot: FileExplorerPrepareSessionRequest['root'],
  }) => {
    const session = await createStandaloneWorkerSession<IFileExplorerWorker>({ createWorker: createStandaloneWorker });
    const { remote } = session;
    try {
      const prepareResponse = await remote.prepareSession(
        workerCapability({
          value: { request: { root: requestRoot } },
          capability: 'file-system-handle-clone',
        }),
        naidanSysfsRemoteReader
          ? workerProxy({ value: naidanSysfsRemoteReader })
          : undefined,
        storageDirectoryRemote
          ? workerProxy({ value: storageDirectoryRemote })
          : undefined,
      );
      return {
        session,
        remote,
        sessionId: fileExplorerPrepareSessionResponseSchema.parse(prepareResponse).sessionId,
      };
    } catch (error) {
      await disposeStandaloneWorkerSession({
        session,
        beforeRelease: undefined,
        cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      }).catch(() => undefined);
      throw error;
    }
  };

  const runtime = root.kind !== 'storage-directory' && hasFileExplorerFileSystemHandles({ root })
    ? await runWithFileSystemHandleCloneFallback({
      direct: () => createRuntime({ requestRoot }),
      fallback: async () => createRuntime({
        requestRoot: await mapFileExplorerRootToOpfsLocators({ root }),
      }),
    })
    : await createRuntime({ requestRoot });
  const { session, remote, sessionId } = runtime;

  if (session === undefined || remote === undefined) {
    throw new Error('Standalone File Explorer Worker initialization did not establish a session');
  }
  const activeSession = session;
  const activeRemote = remote;

  return {
    async readDirectory({ path }) {
      return fileExplorerReadDirectoryResponseSchema.parse(
        await activeRemote.readDirectory({ request: { sessionId, path } }),
      );
    },
    async readPreview({ path, mode }) {
      return fileExplorerReadPreviewResponseSchema.parse(
        await activeRemote.readPreview({ request: { sessionId, path, mode } }),
      );
    },
    async readFile({ path }) {
      return fileExplorerReadFileResponseSchema.parse(
        await activeRemote.readFile({ request: { sessionId, path } }),
      );
    },
    async suggestArchiveExclusions({ directoryPath, query, excludedRelativePaths }) {
      return fileExplorerSuggestArchiveExclusionsResponseSchema.parse(
        await activeRemote.suggestArchiveExclusions({
          request: { sessionId, directoryPath, query, excludedRelativePaths },
        }),
      );
    },
    startDirectoryArchive({ directoryPath, excludedRelativePaths }) {
      const jobId = createDirectoryArchiveJobId();
      return {
        result: activeRemote.createDirectoryArchive({
          request: { sessionId, jobId, directoryPath, excludedRelativePaths },
        }).then(response => fileExplorerCreateDirectoryArchiveResponseSchema.parse(response)),
        async cancel() {
          await activeRemote.cancelDirectoryArchive({ request: { sessionId, jobId } });
        },
      };
    },
    async createFile({ parentPath, name }) {
      await activeRemote.createFile({ request: { sessionId, parentPath, name } });
    },
    async createFolder({ parentPath, name }) {
      await activeRemote.createFolder({ request: { sessionId, parentPath, name } });
    },
    async deleteEntries({ paths }) {
      await activeRemote.deleteEntries({ request: { sessionId, paths } });
    },
    async renameEntry({ path, newName }) {
      await activeRemote.renameEntry({ request: { sessionId, path, newName } });
    },
    async copyEntries({ sourcePaths, targetDirectoryPath }) {
      await activeRemote.copyEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } });
    },
    async moveEntries({ sourcePaths, targetDirectoryPath }) {
      await activeRemote.moveEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } });
    },
    async analyzeZipUpload({ analysisId, targetDirectoryPath, fileName, blob }) {
      return fileExplorerAnalyzeZipUploadResponseSchema.parse(
        await activeRemote.analyzeZipUpload({
          request: { sessionId, analysisId, targetDirectoryPath, fileName, blob },
        }),
      );
    },
    async readZipUploadPreviewDirectory({ analysisId, placement, relativePath }) {
      const plainPlacement = toPlainFileExplorerZipUploadPlacement({ placement });
      return fileExplorerReadZipUploadPreviewDirectoryResponseSchema.parse(
        await activeRemote.readZipUploadPreviewDirectory({
          request: { sessionId, analysisId, placement: plainPlacement, relativePath },
        }),
      );
    },
    startZipUpload({ analysisId, placement }) {
      const jobId = createZipUploadJobId();
      const plainPlacement = toPlainFileExplorerZipUploadPlacement({ placement });
      return {
        result: activeRemote.executeZipUpload({
          request: { sessionId, analysisId, jobId, placement: plainPlacement },
        }).then(response => fileExplorerExecuteZipUploadResponseSchema.parse(response)),
        async cancel() {
          await activeRemote.cancelZipUpload({ request: { sessionId, jobId } });
        },
      };
    },
    async disposeZipUploadAnalysis({ analysisId }) {
      await activeRemote.disposeZipUploadAnalysis({ request: { sessionId, analysisId } });
    },
    async uploadFiles({ targetDirectoryPath, files }) {
      await activeRemote.uploadFiles({ request: { sessionId, targetDirectoryPath, files } });
    },
    async dispose() {
      await disposeStandaloneWorkerSession({
        session: activeSession,
        beforeRelease: async () => {
          const results = await Promise.allSettled([
            activeRemote.disposeSession({ request: { sessionId } }),
            storageDirectoryRemote?.dispose(),
          ]);
          const failures = results.flatMap(result => {
            switch (result.status) {
            case 'fulfilled':
              return [];
            case 'rejected':
              return [result.reason];
            default: {
              const _ex: never = result;
              throw new Error(`Unhandled File Explorer cleanup result: ${String(_ex)}`);
            }
            }
          });
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, 'File Explorer session cleanup failed');
        },
        cleanupTimeoutMs: STANDALONE_WORKER_CLEANUP_TIMEOUT_MS,
      });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
