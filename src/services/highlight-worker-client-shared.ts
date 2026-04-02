import type { EmptyArgs } from '@/models/types'
import { createHighlightWorkerClient } from './highlight-worker-client'
import type { HighlightWorkerClient } from './highlight.worker.types'

let sharedHighlightWorkerClientPromise: Promise<HighlightWorkerClient> | undefined
let sharedHighlightWorkerClientRefCount = 0

export async function acquireSharedHighlightWorkerClient(_args: EmptyArgs): Promise<HighlightWorkerClient> {
  sharedHighlightWorkerClientRefCount += 1
  sharedHighlightWorkerClientPromise ??= createHighlightWorkerClient({})
  return sharedHighlightWorkerClientPromise
}

export async function releaseSharedHighlightWorkerClient(_args: EmptyArgs): Promise<void> {
  sharedHighlightWorkerClientRefCount = Math.max(0, sharedHighlightWorkerClientRefCount - 1)

  if (sharedHighlightWorkerClientRefCount > 0 || !sharedHighlightWorkerClientPromise) {
    return
  }

  const clientPromise = sharedHighlightWorkerClientPromise
  sharedHighlightWorkerClientPromise = undefined
  const client = await clientPromise
  await client.dispose({})
}
