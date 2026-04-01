import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import {
  fileExplorerPrepareSessionResponseSchema,
  fileExplorerReadDirectoryResponseSchema,
  fileExplorerReadFileResponseSchema,
  fileExplorerReadPreviewResponseSchema,
  type FileExplorerRootDescriptor,
  type FileExplorerWorkerClient,
  type IFileExplorerWorker,
} from './file-explorer.worker.types'

export async function createFileExplorerWorkerClient({
  root,
}: {
  root: FileExplorerRootDescriptor
}): Promise<FileExplorerWorkerClient> {
  const worker = new Worker(
    new URL('./file-explorer.worker.ts', import.meta.url),
    {
      type: 'module',
      name: 'naidan-file-explorer-worker',
    },
  )
  const remote = Comlink.wrap<IFileExplorerWorker>(worker)
  const prepareResponse = await remote.prepareSession({ request: { root } })
  const sessionId = fileExplorerPrepareSessionResponseSchema.parse(prepareResponse).sessionId

  return {
    async readDirectory({ path }) {
      return fileExplorerReadDirectoryResponseSchema.parse(
        await remote.readDirectory({ request: { sessionId, path } }),
      )
    },
    async readPreview({ path, mode }) {
      return fileExplorerReadPreviewResponseSchema.parse(
        await remote.readPreview({ request: { sessionId, path, mode } }),
      )
    },
    async readFile({ path }) {
      return fileExplorerReadFileResponseSchema.parse(
        await remote.readFile({ request: { sessionId, path } }),
      )
    },
    async createFile({ parentPath, name }) {
      await remote.createFile({ request: { sessionId, parentPath, name } })
    },
    async createFolder({ parentPath, name }) {
      await remote.createFolder({ request: { sessionId, parentPath, name } })
    },
    async deleteEntries({ paths }) {
      await remote.deleteEntries({ request: { sessionId, paths } })
    },
    async renameEntry({ path, newName }) {
      await remote.renameEntry({ request: { sessionId, path, newName } })
    },
    async copyEntries({ sourcePaths, targetDirectoryPath }) {
      await remote.copyEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } })
    },
    async moveEntries({ sourcePaths, targetDirectoryPath }) {
      await remote.moveEntries({ request: { sessionId, sourcePaths, targetDirectoryPath } })
    },
    async uploadFiles({ targetDirectoryPath, files }) {
      await remote.uploadFiles({ request: { sessionId, targetDirectoryPath, files } })
    },
    async dispose(_args: EmptyArgs) {
      try {
        await remote.disposeSession({ request: { sessionId } })
        await remote[Comlink.releaseProxy]()
      } finally {
        worker.terminate()
      }
    },
  }
}
