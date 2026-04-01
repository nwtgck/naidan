import type { EmptyArgs } from '@/models/types'
import {
  FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_ID,
  FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_NAME,
} from '@/models/constants'
import { getCachedStandaloneWorkerFile } from './standalone-worker-cache'

function getEmbeddedWorkerSource({ workerId }: {
  workerId: string
}): string {
  const scriptElement = document.getElementById(workerId)

  if (!(scriptElement instanceof HTMLScriptElement)) {
    throw new Error(`Embedded worker source not found: ${workerId}`)
  }

  const source = scriptElement.textContent
  if (!source) {
    throw new Error(`Embedded worker source is empty: ${workerId}`)
  }

  return source
}

export async function createFileProtocolCompatibleStandaloneWorkerHub(_args: EmptyArgs): Promise<Worker> {
  const cachedFile = await getCachedStandaloneWorkerFile({
    workerId: FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_ID,
  })
  const blob = cachedFile ?? new Blob(
    [getEmbeddedWorkerSource({ workerId: FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_ID })],
    { type: 'text/javascript' },
  )
  const objectUrl = URL.createObjectURL(blob)

  try {
    return new Worker(objectUrl, { name: FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_NAME })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
