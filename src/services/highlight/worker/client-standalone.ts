import * as Comlink from 'comlink'

import { createFileProtocolCompatibleStandaloneWorkerHub } from '@/services/worker-hub-standalone-loader'
import type { IWorkerHub } from '@/services/worker-hub.types'
import {
  highlightResponseSchema,
  type HighlightWorkerClient,
} from './types'

export async function createHighlightWorkerClient(): Promise<HighlightWorkerClient> {
  const worker = await createFileProtocolCompatibleStandaloneWorkerHub()
  const remote = Comlink.wrap<IWorkerHub>(worker)
  const highlight = await remote.highlight

  return {
    async highlight({ request }) {
      return highlightResponseSchema.parse(await highlight.highlight({ request }))
    },
    async dispose() {
      try {
        await remote[Comlink.releaseProxy]()
      } finally {
        worker.terminate()
      }
    },
  }
}
