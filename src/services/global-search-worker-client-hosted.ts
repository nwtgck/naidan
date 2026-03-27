import * as Comlink from 'comlink'
import { GLOBAL_SEARCH_WORKER_NAME } from '@/models/constants'
import type { EmptyArgs } from '@/models/types'
import {
  globalSearchWorkerPrepareSessionResponseSchema,
  globalSearchWorkerSearchChatContentResponseSchema,
  globalSearchWorkerSearchTitlesResponseSchema,
  type GlobalSearchWorkerClient,
  type IGlobalSearchWorker,
} from './global-search.worker.types'

export async function createGlobalSearchWorkerClient(_args: EmptyArgs): Promise<GlobalSearchWorkerClient> {
  const worker = new Worker(
    new URL('./global-search.worker.ts', import.meta.url),
    {
      type: 'module',
      name: GLOBAL_SEARCH_WORKER_NAME,
    },
  )
  const remote = Comlink.wrap<IGlobalSearchWorker>(worker)

  return {
    async prepareSession({ request }) {
      const response = await remote.prepareSession({ request })
      return globalSearchWorkerPrepareSessionResponseSchema.parse(response)
    },
    async searchTitles({ request }) {
      const response = await remote.searchTitles({ request })
      return globalSearchWorkerSearchTitlesResponseSchema.parse(response)
    },
    async searchChatContent({ request }) {
      const response = await remote.searchChatContent({ request })
      return globalSearchWorkerSearchChatContentResponseSchema.parse(response)
    },
    async disposeSession({ request }) {
      await remote.disposeSession({ request })
    },
    async dispose(_args: EmptyArgs) {
      await remote[Comlink.releaseProxy]()
      worker.terminate()
    },
  }
}
