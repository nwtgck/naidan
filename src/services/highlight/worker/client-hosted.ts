import * as Comlink from 'comlink'
import type { EmptyArgs } from '@/models/types'
import { createHighlightWorker } from './impl'
import {
  highlightResponseSchema,
  type HighlightWorkerClient,
  type IHighlightWorker,
} from './types'

function createMainThreadFallbackClient(_args: EmptyArgs): HighlightWorkerClient {
  const worker = createHighlightWorker({})

  return {
    async highlight({ request }) {
      return highlightResponseSchema.parse(await worker.highlight({ request }))
    },
    async dispose(_args: EmptyArgs) {
    },
  }
}

export async function createHighlightWorkerClient(_args: EmptyArgs): Promise<HighlightWorkerClient> {
  if (typeof Worker === 'undefined') {
    return createMainThreadFallbackClient({})
  }

  const worker = new Worker(
    new URL('./entry.ts', import.meta.url),
    {
      type: 'module',
      name: 'naidan-highlight-worker',
    },
  )
  const remote = Comlink.wrap<IHighlightWorker>(worker)

  return {
    async highlight({ request }) {
      return highlightResponseSchema.parse(await remote.highlight({ request }))
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
