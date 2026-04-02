import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { createFileProtocolCompatibleStandaloneWorkerHub } from '@/services/worker-hub-standalone-loader'
import type { IWorkerHub } from '@/services/worker-hub.types'
import {
  highlightResponseSchema,
  type HighlightWorkerClient,
} from './types'

export async function createHighlightWorkerClient(_args: EmptyArgs): Promise<HighlightWorkerClient> {
  const worker = await createFileProtocolCompatibleStandaloneWorkerHub({})
  const remote = Comlink.wrap<IWorkerHub>(worker)
  const highlight = await remote.highlight

  return {
    async highlight({ request }) {
      return highlightResponseSchema.parse(await highlight.highlight({ request }))
    },
    async dispose(_args: EmptyArgs) {
      try {
        await remote[Comlink.releaseProxy]()
      } finally {
        worker.terminate()
      }
    },
  }
}
