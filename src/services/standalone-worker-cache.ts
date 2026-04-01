import {
  NAIDAN_CACHE_DIRECTORY_NAME,
  STANDALONE_WORKER_CACHE_DIRECTORY_NAME,
  STANDALONE_WORKER_MANIFEST_SCRIPT_ID,
} from '@/models/constants'
import type { EmptyArgs } from '@/models/types'
import { z } from 'zod'

const standaloneWorkerManifestEntrySchema = z.object({
  hash: z.string().min(1),
  size: z.number().int().nonnegative(),
})

const standaloneWorkerManifestSchema = z.record(
  z.string().min(1),
  standaloneWorkerManifestEntrySchema,
)

type StandaloneWorkerManifest = z.infer<typeof standaloneWorkerManifestSchema>

let warmScheduled = false

function parseStandaloneWorkerManifest(_args: EmptyArgs): StandaloneWorkerManifest {
  const scriptElement = document.getElementById(STANDALONE_WORKER_MANIFEST_SCRIPT_ID)
  if (!(scriptElement instanceof HTMLScriptElement)) {
    return {}
  }

  const manifestText = scriptElement.textContent
  if (!manifestText) {
    return {}
  }

  try {
    return standaloneWorkerManifestSchema.parse(JSON.parse(manifestText))
  } catch (error) {
    console.warn('Failed to parse standalone worker manifest.', error)
    return {}
  }
}

function getEmbeddedWorkerSource({ workerId }: {
  workerId: string
}): string | undefined {
  const scriptElement = document.getElementById(workerId)
  if (!(scriptElement instanceof HTMLScriptElement)) {
    return undefined
  }

  return scriptElement.textContent || undefined
}

function getWorkerCacheFileName({ workerId, appVersion, hash }: {
  workerId: string
  appVersion: string
  hash: string
}): string {
  return `${workerId}.${appVersion}.${hash}.js`
}

async function getStandaloneWorkerCacheDirectory(_args: EmptyArgs): Promise<FileSystemDirectoryHandle | undefined> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    return undefined
  }

  try {
    const rootHandle = await navigator.storage.getDirectory()
    const cacheRootHandle = await rootHandle.getDirectoryHandle(NAIDAN_CACHE_DIRECTORY_NAME, { create: true })
    return cacheRootHandle.getDirectoryHandle(STANDALONE_WORKER_CACHE_DIRECTORY_NAME, { create: true })
  } catch {
    return undefined
  }
}

async function writeStandaloneWorkerCacheFile({
  directoryHandle,
  fileName,
  source,
}: {
  directoryHandle: FileSystemDirectoryHandle
  fileName: string
  source: string
}): Promise<void> {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true })
  if (!('createWritable' in fileHandle) || typeof fileHandle.createWritable !== 'function') {
    return
  }

  const writable = await fileHandle.createWritable()
  try {
    await writable.write(source)
  } finally {
    await writable.close()
  }
}

async function cleanupStandaloneWorkerCache({
  directoryHandle,
  manifest,
}: {
  directoryHandle: FileSystemDirectoryHandle
  manifest: StandaloneWorkerManifest
}): Promise<void> {
  const expectedFileNames = new Set(
    Object.entries(manifest).map(([workerId, entry]) => getWorkerCacheFileName({
      workerId,
      appVersion: __APP_VERSION__,
      hash: entry.hash,
    })),
  )

  for await (const [name, handle] of directoryHandle.entries()) {
    switch (handle.kind) {
    case 'file':
      if (!expectedFileNames.has(name)) {
        await directoryHandle.removeEntry(name).catch(() => {})
      }
      break
    case 'directory':
      break
    default: {
      const _exhaustiveCheck: never = handle.kind
      throw new Error(`Unhandled cache entry kind: ${_exhaustiveCheck}`)
    }
    }
  }
}

export async function warmStandaloneWorkerCache(_args: EmptyArgs): Promise<void> {
  const manifest = parseStandaloneWorkerManifest({})
  const workerIds = Object.keys(manifest)
  if (workerIds.length === 0) {
    return
  }

  const cacheDirectoryHandle = await getStandaloneWorkerCacheDirectory({})
  if (!cacheDirectoryHandle) {
    return
  }

  for (const workerId of workerIds) {
    const manifestEntry = manifest[workerId]
    if (!manifestEntry) {
      continue
    }

    const source = getEmbeddedWorkerSource({ workerId })
    if (!source) {
      continue
    }

    const fileName = getWorkerCacheFileName({
      workerId,
      appVersion: __APP_VERSION__,
      hash: manifestEntry.hash,
    })

    try {
      await cacheDirectoryHandle.getFileHandle(fileName, { create: false })
    } catch {
      await writeStandaloneWorkerCacheFile({
        directoryHandle: cacheDirectoryHandle,
        fileName,
        source,
      })
    }
  }

  await cleanupStandaloneWorkerCache({
    directoryHandle: cacheDirectoryHandle,
    manifest,
  })
}

export function warmStandaloneWorkerCacheAtIdle(_args: EmptyArgs): void {
  if (warmScheduled) {
    return
  }
  warmScheduled = true

  const run = () => {
    void warmStandaloneWorkerCache({})
  }

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    ;(window as unknown as {
      requestIdleCallback: (callback: () => void) => void
    }).requestIdleCallback(run)
    return
  }

  setTimeout(run, 1000)
}

export async function getCachedStandaloneWorkerFile({ workerId }: {
  workerId: string
}): Promise<File | undefined> {
  const manifest = parseStandaloneWorkerManifest({})
  const manifestEntry = manifest[workerId]
  if (!manifestEntry) {
    return undefined
  }

  const cacheDirectoryHandle = await getStandaloneWorkerCacheDirectory({})
  if (!cacheDirectoryHandle) {
    return undefined
  }

  const fileName = getWorkerCacheFileName({
    workerId,
    appVersion: __APP_VERSION__,
    hash: manifestEntry.hash,
  })

  try {
    const fileHandle = await cacheDirectoryHandle.getFileHandle(fileName, { create: false })
    return fileHandle.getFile()
  } catch {
    return undefined
  }
}
