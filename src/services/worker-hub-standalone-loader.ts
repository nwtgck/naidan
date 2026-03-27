import type { EmptyArgs } from '@/models/types'
import {
  FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_ID,
  FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_NAME,
} from '@/models/constants'

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

export function createFileProtocolCompatibleStandaloneWorkerHub(_args: EmptyArgs): Worker {
  const source = getEmbeddedWorkerSource({ workerId: FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_ID })
  const blob = new Blob([source], { type: 'text/javascript' })
  const objectUrl = URL.createObjectURL(blob)

  try {
    return new Worker(objectUrl, { name: FILE_PROTOCOL_COMPATIBLE_STANDALONE_WORKER_HUB_NAME })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
