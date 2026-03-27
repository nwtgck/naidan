import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { createFileProtocolCompatibleStandaloneWorkerHub } from './worker-hub-standalone-loader'
import type { IWorkerHub } from './worker-hub.types'
import {
  globalSearchWorkerPrepareSessionResponseSchema,
  globalSearchWorkerSearchChatContentResponseSchema,
  globalSearchWorkerSearchTitlesResponseSchema,
  type GlobalSearchWorkerClient,
} from './global-search.worker.types'

export async function createGlobalSearchWorkerClient(_args: EmptyArgs): Promise<GlobalSearchWorkerClient> {
  const worker = createFileProtocolCompatibleStandaloneWorkerHub({})
  const remote = Comlink.wrap<IWorkerHub>(worker)
  const globalSearch = await remote.globalSearch

  return {
    async prepareSession({ request }) {
      const response = await globalSearch.prepareSession({ request })
      return globalSearchWorkerPrepareSessionResponseSchema.parse(response)
    },
    async searchTitles({ request }) {
      const response = await globalSearch.searchTitles({ request })
      return globalSearchWorkerSearchTitlesResponseSchema.parse(response)
    },
    async searchChatContent({ request }) {
      const response = await globalSearch.searchChatContent({ request })
      return globalSearchWorkerSearchChatContentResponseSchema.parse(response)
    },
    async disposeSession({ request }) {
      await globalSearch.disposeSession({ request })
    },
    async dispose(_args: EmptyArgs) {
      await remote[Comlink.releaseProxy]()
      worker.terminate()
    },
  }
}
