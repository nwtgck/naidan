import * as Comlink from 'comlink'

import { createFileProtocolStandaloneWorkerHub } from '@/services/worker-hub-standalone-loader'
import type { IWorkerHub } from '@/services/worker-hub.types'
import {
  globalSearchWorkerPrepareSessionResponseSchema,
  globalSearchWorkerSearchChatContentResponseSchema,
  globalSearchWorkerSearchTitlesResponseSchema,
  type GlobalSearchWorkerClient,
} from './types'

export async function createGlobalSearchWorkerClient(): Promise<GlobalSearchWorkerClient> {
  const worker = await createFileProtocolStandaloneWorkerHub()
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
    async dispose() {
      await remote[Comlink.releaseProxy]()
      worker.terminate()
    },
  }
}
