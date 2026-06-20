
import { createHighlightWorkerClient } from '@/services/highlight/worker/client'
import type { HighlightWorkerClient } from './types'

let sharedHighlightWorkerClientPromise: Promise<HighlightWorkerClient> | undefined
let sharedHighlightWorkerClientRefCount = 0

export async function acquireSharedHighlightWorkerClient(): Promise<HighlightWorkerClient> {
  sharedHighlightWorkerClientRefCount += 1
  sharedHighlightWorkerClientPromise ??= createHighlightWorkerClient()
  return sharedHighlightWorkerClientPromise
}

export async function releaseSharedHighlightWorkerClient(): Promise<void> {
  sharedHighlightWorkerClientRefCount = Math.max(0, sharedHighlightWorkerClientRefCount - 1)

  if (sharedHighlightWorkerClientRefCount > 0 || !sharedHighlightWorkerClientPromise) {
    return
  }

  const clientPromise = sharedHighlightWorkerClientPromise
  sharedHighlightWorkerClientPromise = undefined
  const client = await clientPromise
  await client.dispose()
}
