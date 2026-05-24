import type { EmptyArgs } from '@/models/types'
import { WeshVFS } from '@/services/wesh/vfs'
import { NaidanSysfsProvider } from '@/services/wesh/naidan-sysfs/provider'
import {
  createOpfsNaidanSysfsStorageReader,
  createRemoteNaidanSysfsStorageReader,
} from '@/services/wesh/naidan-sysfs/storage-reader'
import { EXTENSION_LANGUAGE_MAP, MEDIA_PREVIEW_SIZE_LIMIT, TEXT_PREVIEW_SIZE_LIMIT } from '@/components/file-explorer/constants'
import { getFileExtension, getMimeCategory } from '@/components/file-explorer/utils'
import {
  fileExplorerCreateFileRequestSchema,
  fileExplorerCreateFolderRequestSchema,
  fileExplorerDeleteEntriesRequestSchema,
  fileExplorerDisposeSessionRequestSchema,
  fileExplorerPathSegmentSchema,
  fileExplorerPrepareSessionRequestSchema,
  fileExplorerPrepareSessionResponseSchema,
  fileExplorerReadDirectoryRequestSchema,
  fileExplorerReadDirectoryResponseSchema,
  fileExplorerReadFileRequestSchema,
  fileExplorerReadFileResponseSchema,
  fileExplorerReadPreviewRequestSchema,
  fileExplorerReadPreviewResponseSchema,
  fileExplorerRenameEntryRequestSchema,
  fileExplorerTransferEntriesRequestSchema,
  fileExplorerUploadFilesRequestSchema,
  type FileExplorerEntryRecord,
  type FileExplorerPathSegment,
  type FileExplorerRootDescriptor,
  type IFileExplorerWorker,
} from './types'

type FileExplorerSession =
  | {
    kind: 'native-directory'
    rootName: string
    rootHandle: FileSystemDirectoryHandle
    readOnly: boolean
  }
  | {
    kind: 'wesh-mounts'
    rootName: string
    vfs: WeshVFS
  }

type ResolvedDirectory =
  | {
    kind: 'native-directory'
    name: string
    path: string
    handle: FileSystemDirectoryHandle
    readOnly: boolean
  }
  | {
    kind: 'virtual-directory'
    name: string
    path: string
    readOnly: boolean
  }

type ResolvedFile = {
  kind: 'native-file'
  name: string
  path: string
  handle: FileSystemFileHandle
  readOnly: boolean
}

type ResolvedVirtualFile = {
  kind: 'virtual-file'
  name: string
  path: string
  readOnly: boolean
  vfs: WeshVFS
}

const sessions = new Map<string, FileExplorerSession>()

function createSessionId(): string {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `file-explorer-session-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizeExplorerPath({ path }: { path: string }): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') {
    return '/'
  }
  return `/${trimmed.split('/').filter(segment => segment.length > 0).join('/')}`
}

function splitExplorerPath({ path }: { path: string }): string[] {
  const normalized = normalizeExplorerPath({ path })
  if (normalized === '/') {
    return []
  }
  return normalized.slice(1).split('/')
}

function joinExplorerPath({ parentPath, name }: { parentPath: string, name: string }): string {
  const normalizedParentPath = normalizeExplorerPath({ path: parentPath })
  return normalizedParentPath === '/' ? `/${name}` : `${normalizedParentPath}/${name}`
}

function getBaseNameFromPath({ path, rootName }: { path: string, rootName: string }): string {
  const segments = splitExplorerPath({ path })
  return segments.at(-1) ?? rootName
}

function getParentPath({ path }: { path: string }): string {
  const segments = splitExplorerPath({ path })
  if (segments.length <= 1) {
    return '/'
  }
  return `/${segments.slice(0, -1).join('/')}`
}

function getSession({ sessionId }: { sessionId: string }): FileExplorerSession {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new Error(`File explorer session not found: ${sessionId}`)
  }
  return session
}

async function createSessionFromRoot({ root }: { root: FileExplorerRootDescriptor }): Promise<FileExplorerSession> {
  switch (root.kind) {
  case 'opfs-root':
    return {
      kind: 'native-directory',
      rootName: root.rootName,
      rootHandle: await navigator.storage.getDirectory(),
      readOnly: false,
    }
  case 'native-directory':
    return {
      kind: 'native-directory',
      rootName: root.rootName,
      rootHandle: root.handle,
      readOnly: root.readOnly,
    }
  case 'wesh-mounts': {
    const vfs = new WeshVFS({ rootHandle: undefined })
    for (const mount of root.mounts) {
      switch (mount.type) {
      case 'directory':
        await vfs.mount({
          path: mount.path,
          handle: mount.handle,
          readOnly: mount.readOnly,
        })
        break
      case 'naidan_sysfs': {
        const reader = await (() => {
          switch (mount.storageType) {
          case 'opfs':
            return createOpfsNaidanSysfsStorageReader({})
          case 'local':
          case 'memory':
            if (root.naidanSysfsRemoteReader === undefined) {
              throw new Error(`Naidan sysfs remote reader is required for ${mount.storageType} storage`)
            }
            return createRemoteNaidanSysfsStorageReader({
              remoteReader: root.naidanSysfsRemoteReader,
            })
          default: {
            const _exhaustiveCheck: never = mount.storageType
            throw new Error(`Unhandled naidan sysfs storage type: ${String(_exhaustiveCheck)}`)
          }
          }
        })()

        vfs.mountVirtual({
          path: mount.path,
          readOnly: mount.readOnly,
          provider: new NaidanSysfsProvider({
            reader,
            visibility: mount.visibility,
            currentChatId: mount.currentChatId,
            currentChatGroupId: mount.currentChatGroupId,
          }),
        })
        break
      }
      default: {
        const _exhaustiveCheck: never = mount
        throw new Error(`Unhandled wesh mount: ${String(_exhaustiveCheck)}`)
      }
      }
    }
    return {
      kind: 'wesh-mounts',
      rootName: root.rootName,
      vfs,
    }
  }
  default: {
    const _exhaustiveCheck: never = root
    throw new Error(`Unhandled root descriptor: ${String(_exhaustiveCheck)}`)
  }
  }
}

async function resolveNativeDirectoryHandle({
  rootHandle,
  path,
}: {
  rootHandle: FileSystemDirectoryHandle
  path: string
}): Promise<FileSystemDirectoryHandle> {
  let current = rootHandle
  for (const segment of splitExplorerPath({ path })) {
    current = await current.getDirectoryHandle(segment)
  }
  return current
}

async function resolveNativeDirectory({
  rootHandle,
  rootName,
  readOnly,
  path,
}: {
  rootHandle: FileSystemDirectoryHandle
  rootName: string
  readOnly: boolean
  path: string
}): Promise<ResolvedDirectory> {
  const normalizedPath = normalizeExplorerPath({ path })
  const handle = await resolveNativeDirectoryHandle({ rootHandle, path: normalizedPath })
  return {
    kind: 'native-directory',
    name: getBaseNameFromPath({ path: normalizedPath, rootName }),
    path: normalizedPath,
    handle,
    readOnly,
  }
}

async function resolveWeshDirectory({
  vfs,
  rootName,
  path,
}: {
  vfs: WeshVFS
  rootName: string
  path: string
}): Promise<ResolvedDirectory> {
  const normalizedPath = normalizeExplorerPath({ path })
  const stat = await vfs.stat({ path: normalizedPath }).catch(() => {
    if (normalizedPath === '/') {
      return { type: 'directory' as const }
    }
    return null
  })
  if (stat === null || stat.type !== 'directory') {
    throw new Error(`Directory not found: ${normalizedPath}`)
  }

  const nativeHandle = await vfs.getNativeHandle({ path: normalizedPath })
  if (nativeHandle !== null && nativeHandle.kind === 'directory') {
    return {
      kind: 'native-directory',
      name: getBaseNameFromPath({ path: normalizedPath, rootName }),
      path: normalizedPath,
      handle: nativeHandle as FileSystemDirectoryHandle,
      readOnly: vfs.getReadOnlyForPath({ path: normalizedPath }),
    }
  }

  return {
    kind: 'virtual-directory',
    name: getBaseNameFromPath({ path: normalizedPath, rootName }),
    path: normalizedPath,
    readOnly: true,
  }
}

async function resolveDirectory({
  session,
  path,
}: {
  session: FileExplorerSession
  path: string
}): Promise<ResolvedDirectory> {
  switch (session.kind) {
  case 'native-directory':
    return resolveNativeDirectory({
      rootHandle: session.rootHandle,
      rootName: session.rootName,
      readOnly: session.readOnly,
      path,
    })
  case 'wesh-mounts':
    return resolveWeshDirectory({
      vfs: session.vfs,
      rootName: session.rootName,
      path,
    })
  default: {
    const _exhaustiveCheck: never = session
    throw new Error(`Unhandled file explorer session: ${String(_exhaustiveCheck)}`)
  }
  }
}

async function resolveFile({
  session,
  path,
}: {
  session: FileExplorerSession
  path: string
}): Promise<ResolvedFile | ResolvedVirtualFile> {
  const normalizedPath = normalizeExplorerPath({ path })
  const name = getBaseNameFromPath({
    path: normalizedPath,
    rootName: session.rootName,
  })

  switch (session.kind) {
  case 'native-directory': {
    const parentHandle = await resolveNativeDirectoryHandle({
      rootHandle: session.rootHandle,
      path: getParentPath({ path: normalizedPath }),
    })
    const handle = await parentHandle.getFileHandle(name)
    return {
      kind: 'native-file',
      name,
      path: normalizedPath,
      handle,
      readOnly: session.readOnly,
    }
  }
  case 'wesh-mounts': {
    const nativeHandle = await session.vfs.getNativeHandle({ path: normalizedPath })
    if (nativeHandle !== null && nativeHandle.kind === 'file') {
      return {
        kind: 'native-file',
        name,
        path: normalizedPath,
        handle: nativeHandle as FileSystemFileHandle,
        readOnly: session.vfs.getReadOnlyForPath({ path: normalizedPath }),
      }
    }

    const stat = await session.vfs.stat({ path: normalizedPath }).catch(() => null)
    if (stat === null || stat.type !== 'file') {
      throw new Error(`File not found: ${normalizedPath}`)
    }

    return {
      kind: 'virtual-file',
      name,
      path: normalizedPath,
      readOnly: session.vfs.getReadOnlyForPath({ path: normalizedPath }),
      vfs: session.vfs,
    }
  }
  default: {
    const _exhaustiveCheck: never = session
    throw new Error(`Unhandled file explorer session: ${String(_exhaustiveCheck)}`)
  }
  }
}

async function readAllBytesFromVirtualFile({
  vfs,
  path,
}: {
  vfs: WeshVFS
  path: string
}): Promise<Uint8Array> {
  const handle = await vfs.open({
    path,
    flags: {
      access: 'read',
      creation: 'never',
      truncate: 'preserve',
      append: 'preserve',
    },
    mode: undefined,
  })

  try {
    const chunks: Uint8Array[] = []
    while (true) {
      const buffer = new Uint8Array(64 * 1024)
      const { bytesRead } = await handle.read({ buffer })
      if (bytesRead === 0) {
        break
      }
      chunks.push(buffer.subarray(0, bytesRead))
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const merged = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged
  } finally {
    await handle.close()
  }
}

async function readBlobText({ blob }: { blob: Blob }): Promise<string> {
  if (typeof blob.text === 'function') {
    return blob.text()
  }
  if (typeof blob.arrayBuffer !== 'function') {
    throw new Error('Blob text reading is not supported in this environment')
  }
  const buffer = await blob.arrayBuffer()
  return new TextDecoder().decode(buffer)
}

function uint8ArrayToBlobPart({ bytes }: { bytes: Uint8Array }): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function assertDirectoryIsWritable({ directory }: {
  directory: ResolvedDirectory
}): void {
  if (directory.readOnly || directory.kind !== 'native-directory') {
    throw new DOMException('Read-only file system', 'NotAllowedError')
  }
}

function getWritableNativeDirectory({ directory }: {
  directory: ResolvedDirectory
}): FileSystemDirectoryHandle {
  assertDirectoryIsWritable({ directory })
  switch (directory.kind) {
  case 'native-directory':
    return directory.handle
  case 'virtual-directory':
    throw new DOMException('Read-only file system', 'NotAllowedError')
  default: {
    const _exhaustiveCheck: never = directory
    throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`)
  }
  }
}

async function listDirectoryEntries({
  session,
  directory,
}: {
  session: FileExplorerSession
  directory: ResolvedDirectory
}): Promise<FileExplorerEntryRecord[]> {
  switch (directory.kind) {
  case 'native-directory':
    return listNativeDirectoryEntries({
      handle: directory.handle,
      directoryPath: directory.path,
      readOnly: directory.readOnly,
    })
  case 'virtual-directory':
    switch (session.kind) {
    case 'wesh-mounts':
      return listWeshVirtualDirectoryEntries({
        vfs: session.vfs,
        directoryPath: directory.path,
      })
    case 'native-directory':
      throw new Error(`Virtual directory not supported for native session: ${directory.path}`)
    default: {
      const _exhaustiveCheck: never = session
      throw new Error(`Unhandled file explorer session: ${String(_exhaustiveCheck)}`)
    }
    }
  default: {
    const _exhaustiveCheck: never = directory
    throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`)
  }
  }
}

async function listNativeDirectoryEntries({
  handle,
  directoryPath,
  readOnly,
}: {
  handle: FileSystemDirectoryHandle
  directoryPath: string
  readOnly: boolean
}): Promise<FileExplorerEntryRecord[]> {
  const entries: FileExplorerEntryRecord[] = []

  for await (const childHandle of handle.values()) {
    switch (childHandle.kind) {
    case 'directory':
      entries.push({
        path: joinExplorerPath({ parentPath: directoryPath, name: childHandle.name }),
        name: childHandle.name,
        kind: 'directory',
        size: undefined,
        lastModified: undefined,
        extension: '',
        mimeCategory: 'binary',
        readOnly,
        canNavigate: true,
        canMutate: !readOnly,
      })
      break
    case 'file': {
      const extension = getFileExtension({ name: childHandle.name })
      const mimeCategory = getMimeCategory({ extension })
      let size: number | undefined
      let lastModified: number | undefined
      try {
        const file = await (childHandle as FileSystemFileHandle).getFile()
        size = file.size
        lastModified = file.lastModified
      } catch {
        size = undefined
        lastModified = undefined
      }
      entries.push({
        path: joinExplorerPath({ parentPath: directoryPath, name: childHandle.name }),
        name: childHandle.name,
        kind: 'file',
        size,
        lastModified,
        extension,
        mimeCategory,
        readOnly,
        canNavigate: false,
        canMutate: !readOnly,
      })
      break
    }
    default: {
      const _exhaustiveCheck: never = childHandle.kind
      throw new Error(`Unhandled directory child kind: ${String(_exhaustiveCheck)}`)
    }
    }
  }

  return entries
}

async function listWeshVirtualDirectoryEntries({
  vfs,
  directoryPath,
}: {
  vfs: WeshVFS
  directoryPath: string
}): Promise<FileExplorerEntryRecord[]> {
  const entries: FileExplorerEntryRecord[] = []

  for await (const entry of vfs.readDir({ path: directoryPath })) {
    switch (entry.type) {
    case 'directory': {
      const nativeHandle = await vfs.getNativeHandle({ path: entry.fullPath })
      const readOnly = nativeHandle !== null && nativeHandle.kind === 'directory'
        ? vfs.getReadOnlyForPath({ path: entry.fullPath })
        : true

      entries.push({
        path: normalizeExplorerPath({ path: entry.fullPath }),
        name: entry.name,
        kind: 'directory',
        size: undefined,
        lastModified: undefined,
        extension: '',
        mimeCategory: 'binary',
        readOnly,
        canNavigate: true,
        canMutate: false,
      })
      break
    }
    case 'file': {
      const nativeHandle = await vfs.getNativeHandle({ path: entry.fullPath })
      const extension = getFileExtension({ name: entry.name })
      const mimeCategory = getMimeCategory({ extension })
      const stat = await vfs.stat({ path: entry.fullPath })

      entries.push({
        path: normalizeExplorerPath({ path: entry.fullPath }),
        name: entry.name,
        kind: 'file',
        size: stat.size,
        lastModified: stat.mtime || undefined,
        extension,
        mimeCategory,
        readOnly: nativeHandle !== null && nativeHandle.kind === 'file'
          ? vfs.getReadOnlyForPath({ path: entry.fullPath })
          : true,
        canNavigate: false,
        canMutate: false,
      })
      break
    }
    case 'symlink': {
      const resolved = await vfs.resolve({ path: entry.fullPath })
      const extension = getFileExtension({ name: entry.name })
      const mimeCategory = getMimeCategory({ extension })

      switch (resolved.stat.type) {
      case 'directory':
        entries.push({
          path: normalizeExplorerPath({ path: entry.fullPath }),
          name: entry.name,
          kind: 'directory',
          size: undefined,
          lastModified: resolved.stat.mtime || undefined,
          extension: '',
          mimeCategory: 'binary',
          readOnly: true,
          canNavigate: true,
          canMutate: false,
        })
        break
      case 'file':
        entries.push({
          path: normalizeExplorerPath({ path: entry.fullPath }),
          name: entry.name,
          kind: 'file',
          size: resolved.stat.size,
          lastModified: resolved.stat.mtime || undefined,
          extension,
          mimeCategory,
          readOnly: true,
          canNavigate: false,
          canMutate: false,
        })
        break
      case 'fifo':
      case 'chardev':
      case 'symlink':
        break
      default: {
        const _exhaustiveCheck: never = resolved.stat.type
        throw new Error(`Unhandled resolved VFS entry type: ${String(_exhaustiveCheck)}`)
      }
      }
      break
    }
    case 'fifo':
    case 'chardev':
      break
    default: {
      const _exhaustiveCheck: never = entry.type
      throw new Error(`Unhandled VFS entry type: ${String(_exhaustiveCheck)}`)
    }
    }
  }

  return entries
}

function buildPathSegments({
  path,
  rootName,
}: {
  path: string
  rootName: string
}): FileExplorerPathSegment[] {
  const normalizedPath = normalizeExplorerPath({ path })
  const segments = splitExplorerPath({ path: normalizedPath })
  const pathSegments: FileExplorerPathSegment[] = [
    fileExplorerPathSegmentSchema.parse({
      name: rootName,
      path: '/',
    }),
  ]

  for (let i = 0; i < segments.length; i += 1) {
    pathSegments.push(fileExplorerPathSegmentSchema.parse({
      name: segments[i]!,
      path: `/${segments.slice(0, i + 1).join('/')}`,
    }))
  }

  return pathSegments
}

async function copyFileHandleToDirectory({
  sourceHandle,
  targetDirectoryHandle,
}: {
  sourceHandle: FileSystemFileHandle
  targetDirectoryHandle: FileSystemDirectoryHandle
}): Promise<void> {
  const file = await sourceHandle.getFile()
  const targetFileHandle = await targetDirectoryHandle.getFileHandle(sourceHandle.name, { create: true })
  const writable = await (targetFileHandle as unknown as {
    createWritable: () => Promise<FileSystemWritableFileStream>
  }).createWritable()
  try {
    await writable.write(await file.arrayBuffer())
  } finally {
    await writable.close()
  }
}

async function copyDirectoryHandleToDirectory({
  sourceHandle,
  targetDirectoryHandle,
}: {
  sourceHandle: FileSystemDirectoryHandle
  targetDirectoryHandle: FileSystemDirectoryHandle
}): Promise<void> {
  const nextDirectoryHandle = await targetDirectoryHandle.getDirectoryHandle(sourceHandle.name, { create: true })
  for await (const childHandle of sourceHandle.values()) {
    switch (childHandle.kind) {
    case 'file':
      await copyFileHandleToDirectory({
        sourceHandle: childHandle as FileSystemFileHandle,
        targetDirectoryHandle: nextDirectoryHandle,
      })
      break
    case 'directory':
      await copyDirectoryHandleToDirectory({
        sourceHandle: childHandle as FileSystemDirectoryHandle,
        targetDirectoryHandle: nextDirectoryHandle,
      })
      break
    default: {
      const _exhaustiveCheck: never = childHandle.kind
      throw new Error(`Unhandled directory child kind: ${String(_exhaustiveCheck)}`)
    }
    }
  }
}

async function deleteEntryPath({
  session,
  path,
}: {
  session: FileExplorerSession
  path: string
}): Promise<void> {
  const normalizedPath = normalizeExplorerPath({ path })
  const name = getBaseNameFromPath({
    path: normalizedPath,
    rootName: session.rootName,
  })
  const parentDirectory = await resolveDirectory({
    session,
    path: getParentPath({ path: normalizedPath }),
  })
  const writableParentDirectory = getWritableNativeDirectory({ directory: parentDirectory })
  await writableParentDirectory.removeEntry(name, { recursive: true })
}

export function createFileExplorerWorker(_args: EmptyArgs): IFileExplorerWorker {
  return {
    async prepareSession({ request }) {
      const validated = fileExplorerPrepareSessionRequestSchema.parse(request)
      const sessionId = createSessionId()
      sessions.set(sessionId, await createSessionFromRoot({ root: validated.root }))
      return fileExplorerPrepareSessionResponseSchema.parse({ sessionId })
    },

    async readDirectory({ request }) {
      const validated = fileExplorerReadDirectoryRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      const directory = await resolveDirectory({
        session,
        path: validated.path,
      })
      const entries = await listDirectoryEntries({ session, directory })

      return fileExplorerReadDirectoryResponseSchema.parse({
        directoryName: directory.name,
        directoryPath: directory.path,
        readOnly: directory.readOnly,
        pathSegments: buildPathSegments({
          path: directory.path,
          rootName: session.rootName,
        }),
        entries,
      })
    },

    async readPreview({ request }) {
      const validated = fileExplorerReadPreviewRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      const normalizedPath = normalizeExplorerPath({ path: validated.path })

      try {
        await resolveDirectory({ session, path: normalizedPath })
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'directory',
        })
      } catch {
        // The path is not a directory; continue as file.
      }

      const resolvedFile = await resolveFile({ session, path: normalizedPath })
      const nativeFile = await (() => {
        switch (resolvedFile.kind) {
        case 'native-file':
          return resolvedFile.handle.getFile()
        case 'virtual-file':
          return Promise.resolve(undefined)
        default: {
          const _exhaustiveCheck: never = resolvedFile
          throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`)
        }
        }
      })()
      const virtualBytes = await (() => {
        switch (resolvedFile.kind) {
        case 'native-file':
          return Promise.resolve(undefined)
        case 'virtual-file':
          return readAllBytesFromVirtualFile({
            vfs: resolvedFile.vfs,
            path: resolvedFile.path,
          })
        default: {
          const _exhaustiveCheck: never = resolvedFile
          throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`)
        }
        }
      })()
      const extension = getFileExtension({ name: resolvedFile.name })
      const mimeCategory = getMimeCategory({ extension })
      const fileSize = nativeFile?.size ?? virtualBytes?.byteLength ?? 0

      switch (mimeCategory) {
      case 'text': {
        if (validated.mode === 'bounded' && fileSize > TEXT_PREVIEW_SIZE_LIMIT) {
          return fileExplorerReadPreviewResponseSchema.parse({
            kind: 'text',
            rawText: '',
            displayText: '',
            languageHint: EXTENSION_LANGUAGE_MAP[extension],
            oversized: true,
          })
        }

        const rawText = nativeFile !== undefined
          ? await readBlobText({ blob: nativeFile })
          : new TextDecoder().decode(virtualBytes ?? new Uint8Array())
        let displayText = rawText
        if (extension === '.json' || extension === '.jsonl') {
          try {
            displayText = JSON.stringify(JSON.parse(rawText), null, 2)
          } catch {
            displayText = rawText
          }
        }
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'text',
          rawText,
          displayText,
          languageHint: EXTENSION_LANGUAGE_MAP[extension],
          oversized: false,
        })
      }
      case 'image':
      case 'video':
      case 'audio':
        if (validated.mode === 'bounded' && fileSize > MEDIA_PREVIEW_SIZE_LIMIT) {
          return fileExplorerReadPreviewResponseSchema.parse({
            kind: 'media',
            mediaKind: mimeCategory,
            blob: new Blob([]),
            mimeType: nativeFile?.type ?? '',
            oversized: true,
          })
        }
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'media',
          mediaKind: mimeCategory,
          blob: nativeFile ?? new Blob(virtualBytes === undefined ? [] : [uint8ArrayToBlobPart({ bytes: virtualBytes })]),
          mimeType: nativeFile?.type ?? '',
          oversized: false,
        })
      case 'binary':
        return fileExplorerReadPreviewResponseSchema.parse({
          kind: 'binary',
          oversized: false,
        })
      default: {
        const _exhaustiveCheck: never = mimeCategory
        throw new Error(`Unhandled mime category: ${String(_exhaustiveCheck)}`)
      }
      }
    },

    async readFile({ request }) {
      const validated = fileExplorerReadFileRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      const resolvedFile = await resolveFile({
        session,
        path: validated.path,
      })
      switch (resolvedFile.kind) {
      case 'native-file':
        return fileExplorerReadFileResponseSchema.parse({
          blob: await resolvedFile.handle.getFile(),
        })
      case 'virtual-file':
        return fileExplorerReadFileResponseSchema.parse({
          blob: new Blob([uint8ArrayToBlobPart({
            bytes: await readAllBytesFromVirtualFile({
              vfs: resolvedFile.vfs,
              path: resolvedFile.path,
            }),
          })]),
        })
      default: {
        const _exhaustiveCheck: never = resolvedFile
        throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`)
      }
      }
    },

    async createFile({ request }) {
      const validated = fileExplorerCreateFileRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      const directory = await resolveDirectory({
        session,
        path: validated.parentPath,
      })
      const writableDirectory = getWritableNativeDirectory({ directory })
      const fileHandle = await writableDirectory.getFileHandle(validated.name, { create: true })
      const writable = await (fileHandle as unknown as {
        createWritable: () => Promise<FileSystemWritableFileStream>
      }).createWritable()
      await writable.close()
    },

    async createFolder({ request }) {
      const validated = fileExplorerCreateFolderRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      const directory = await resolveDirectory({
        session,
        path: validated.parentPath,
      })
      const writableDirectory = getWritableNativeDirectory({ directory })
      await writableDirectory.getDirectoryHandle(validated.name, { create: true })
    },

    async deleteEntries({ request }) {
      const validated = fileExplorerDeleteEntriesRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      for (const path of validated.paths) {
        await deleteEntryPath({ session, path })
      }
    },

    async renameEntry({ request }) {
      const validated = fileExplorerRenameEntryRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      const normalizedSourcePath = normalizeExplorerPath({ path: validated.path })
      const sourceName = getBaseNameFromPath({
        path: normalizedSourcePath,
        rootName: session.rootName,
      })
      const parentDirectory = await resolveDirectory({
        session,
        path: getParentPath({ path: normalizedSourcePath }),
      })
      const writableParentDirectory = getWritableNativeDirectory({ directory: parentDirectory })

      try {
        const sourceFile = await writableParentDirectory.getFileHandle(sourceName)
        const targetFile = await writableParentDirectory.getFileHandle(validated.newName, { create: true })
        const file = await sourceFile.getFile()
        const writable = await (targetFile as unknown as {
          createWritable: () => Promise<FileSystemWritableFileStream>
        }).createWritable()
        try {
          await writable.write(await file.arrayBuffer())
        } finally {
          await writable.close()
        }
      } catch {
        const sourceDirectory = await writableParentDirectory.getDirectoryHandle(sourceName)
        const targetDirectoryHandle = await writableParentDirectory.getDirectoryHandle(validated.newName, { create: true })
        for await (const childHandle of sourceDirectory.values()) {
          switch (childHandle.kind) {
          case 'file':
            await copyFileHandleToDirectory({
              sourceHandle: childHandle as FileSystemFileHandle,
              targetDirectoryHandle,
            })
            break
          case 'directory':
            await copyDirectoryHandleToDirectory({
              sourceHandle: childHandle as FileSystemDirectoryHandle,
              targetDirectoryHandle,
            })
            break
          default: {
            const _exhaustiveCheck: never = childHandle.kind
            throw new Error(`Unhandled directory child kind: ${String(_exhaustiveCheck)}`)
          }
          }
        }
      }

      await writableParentDirectory.removeEntry(sourceName, { recursive: true })
    },

    async copyEntries({ request }) {
      const validated = fileExplorerTransferEntriesRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      const targetDirectory = await resolveDirectory({
        session,
        path: validated.targetDirectoryPath,
      })
      const writableTargetDirectory = getWritableNativeDirectory({ directory: targetDirectory })

      for (const sourcePath of validated.sourcePaths) {
        const normalizedSourcePath = normalizeExplorerPath({ path: sourcePath })
        try {
          const sourceFile = await resolveFile({ session, path: normalizedSourcePath })
          switch (sourceFile.kind) {
          case 'native-file':
            await copyFileHandleToDirectory({
              sourceHandle: sourceFile.handle,
              targetDirectoryHandle: writableTargetDirectory,
            })
            break
          case 'virtual-file':
            throw new Error(`Cannot copy virtual file: ${normalizedSourcePath}`)
          default: {
            const _exhaustiveCheck: never = sourceFile
            throw new Error(`Unhandled resolved file: ${String(_exhaustiveCheck)}`)
          }
          }
          continue
        } catch {
          const sourceDirectory = await resolveDirectory({
            session,
            path: normalizedSourcePath,
          })
          switch (sourceDirectory.kind) {
          case 'native-directory':
            await copyDirectoryHandleToDirectory({
              sourceHandle: sourceDirectory.handle,
              targetDirectoryHandle: writableTargetDirectory,
            })
            break
          case 'virtual-directory':
            throw new Error(`Cannot copy virtual directory: ${normalizedSourcePath}`)
          default: {
            const _exhaustiveCheck: never = sourceDirectory
            throw new Error(`Unhandled resolved directory: ${String(_exhaustiveCheck)}`)
          }
          }
        }
      }
    },

    async moveEntries({ request }) {
      const validated = fileExplorerTransferEntriesRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      await this.copyEntries({
        request: {
          sessionId: validated.sessionId,
          sourcePaths: validated.sourcePaths,
          targetDirectoryPath: validated.targetDirectoryPath,
        },
      })
      for (const sourcePath of validated.sourcePaths) {
        await deleteEntryPath({ session, path: sourcePath })
      }
    },

    async uploadFiles({ request }) {
      const validated = fileExplorerUploadFilesRequestSchema.parse(request)
      const session = getSession({ sessionId: validated.sessionId })
      const targetDirectory = await resolveDirectory({
        session,
        path: validated.targetDirectoryPath,
      })
      const writableTargetDirectory = getWritableNativeDirectory({ directory: targetDirectory })

      for (const file of validated.files) {
        const targetFileHandle = await writableTargetDirectory.getFileHandle(file.name, { create: true })
        const writable = await (targetFileHandle as unknown as {
          createWritable: () => Promise<FileSystemWritableFileStream>
        }).createWritable()
        try {
          await writable.write(await file.blob.arrayBuffer())
        } finally {
          await writable.close()
        }
      }
    },

    async disposeSession({ request }) {
      const validated = fileExplorerDisposeSessionRequestSchema.parse(request)
      sessions.delete(validated.sessionId)
    },
  }
}
