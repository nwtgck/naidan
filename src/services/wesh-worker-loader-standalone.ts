import {
  FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_ID,
  FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_NAME,
  FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_SCRIPT_TYPE,
} from './wesh-worker.constants'

function getEmbeddedWorkerSource({ workerId }: {
  workerId: string
}): string {
  const selector = `script[type="${FILE_PROTOCOL_COMPATIBLE_WESH_WORKER_SCRIPT_TYPE}"][data-worker-id="${workerId}"]`
  const scriptElement = document.querySelector(selector)

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
