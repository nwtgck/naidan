import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { createFileProtocolCompatibleStandaloneWorkerHub } from './worker-hub-standalone-loader'
import {
  fileExplorerPrepareSessionResponseSchema,
  fileExplorerReadDirectoryResponseSchema,
  fileExplorerReadFileResponseSchema,
  fileExplorerReadPreviewResponseSchema,
  type FileExplorerRootDescriptor,
  type FileExplorerWorkerClient,
  type IFileExplorerWorker,
} from './file-explorer.worker.types'
import type { IWorkerHub } from './worker-hub.types'

export async function createFileExplorerWorkerClient({
  root,
}: {
  root: FileExplorerRootDescriptor
}): Promise<FileExplorerWorkerClient> {
  const worker = await createFileProtocolCompatibleStandaloneWorkerHub({})
  const remote = Comlink.wrap<IWorkerHub>(worker)
  const fileExplorer = await remote.fileExplorer as Comlink.Remote<IFileExplorerWorker>
  const prepareResponse = await fileExplorer.prepareSession({ request: { root } })
  const sessionId = fileExplorerPrepareSessionResponseSchema.parse(prepareResponse).sessionId

  return {
    async readDirectory({ path }) {
      return fileExplorerReadDirectoryResponseSchema.parse(
        await fileExplorer.readDirectory({ request: { sessionId, path } }),
      )
    },
    async readPreview({ path, mode }) {
      return fileExplorerReadPreviewResponseSchema.parse(
        await fileExplorer.readPreview({ request: { sessionId, path, mode } }),
      )
    },
    async readFile({ path }) {
      return fileExplorerReadFileResponseSchema.parse(
        await fileExplorer.readFile({ request: { sessionId, path } }),
      )
    },
    async createFile({ parentPath, name }) {
      await fileExplorer.createFile({ request: { sessionId, parentPath, name } })
    },
    async createFolder({ parentPath, name }) {
      await fileExplorer.createFolder({ request: { sessionId, parentPath, name } })
    },
    async deleteEntries({ paths }) {
      await fileExplorer.deleteEntries({ request: { sessionId, paths } })
    },
    async renameEntry({ path, newName }) {
      await fileExplorer.renameEntry({ request: { sessionId, path, newName } })
    },
    async copyEntries({ sourcePaths, targetDirectoryPath }) {
      await fileExplorer.copyEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } })
    },
    async moveEntries({ sourcePaths, targetDirectoryPath }) {
      await fileExplorer.moveEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } })
    },
    async uploadFiles({ targetDirectoryPath, files }) {
      await fileExplorer.uploadFiles({ request: { sessionId, targetDirectoryPath, files } })
    },
    async dispose(_args: EmptyArgs) {
      try {
        await fileExplorer.disposeSession({ request: { sessionId } })
        await remote[Comlink.releaseProxy]()
      } finally {
        worker.terminate()
      }
    },
  }
}
