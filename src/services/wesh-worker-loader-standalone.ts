import {
  FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_ID,
  FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME,
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

function createEmbeddedClassicWorker({ source, name }: {
  source: string
  name: string
}): Worker {
  const blob = new Blob([source], { type: 'text/javascript' })
  const objectUrl = URL.createObjectURL(blob)

  try {
    return new Worker(objectUrl, { name })
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function createFileProtocolCompatibleWeshWorker(): Worker {
  return createEmbeddedClassicWorker({
    source: getEmbeddedWorkerSource({ workerId: FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_ID }),
    name: FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME,
  })
}
