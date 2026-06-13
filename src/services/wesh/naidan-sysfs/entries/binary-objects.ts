import type { WeshDirEntry, WeshOpenFlags, WeshStat } from '@/services/wesh/types'
import type { NaidanSysfsBinaryObjectAccess } from '@/services/wesh/types'
import {
  NAIDAN_SYSFS_BINARY_OBJECT_DATA_FILE_NAME,
  NAIDAN_SYSFS_BINARY_OBJECTS_BY_ID_DIRECTORY_NAME,
  NAIDAN_SYSFS_BINARY_OBJECTS_DIRECTORY_NAME,
  NAIDAN_SYSFS_METADATA_JSON_FILE_NAME,
  NAIDAN_SYSFS_METADATA_MARKDOWN_FILE_NAME,
} from '@/services/wesh/naidan-sysfs/constants'
import { GeneratedTextFileHandle } from '@/services/wesh/naidan-sysfs/generated-text-file-handle'
import { BlobFileHandle } from '@/services/wesh/naidan-sysfs/blob-file-handle'
import {
  renderBinaryObjectMetadataJson,
  renderBinaryObjectMetadataMarkdown,
} from '@/services/wesh/naidan-sysfs/binary-object-metadata'
import type {
  NaidanSysfsBinaryObject,
  NaidanSysfsContext,
  NaidanSysfsDirectoryEntry,
  NaidanSysfsEntry,
  NaidanSysfsFileEntry,
} from '@/services/wesh/naidan-sysfs/types'

function createDirectoryStat(): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createFileStat({
  size,
  mtime,
}: {
  size: number;
  mtime: number;
}): WeshStat {
  return { size, mode: 0o444, type: 'file', mtime, ino: 0, uid: 0, gid: 0 }
}

function createMetadataFileEntry({
  object,
  fileName,
}: {
  object: NaidanSysfsBinaryObject;
  fileName: 'metadata.json' | 'metadata.md';
}): NaidanSysfsFileEntry {
  const text = fileName === NAIDAN_SYSFS_METADATA_JSON_FILE_NAME
    ? renderBinaryObjectMetadataJson({ object })
    : renderBinaryObjectMetadataMarkdown({ object })
  const size = new TextEncoder().encode(text).length

  return {
    kind: 'file',
    async stat({ path }: { path: string }) {
      void path
      return createFileStat({ size, mtime: object.createdAt })
    },
    async open({ flags }: { path: string; flags: WeshOpenFlags }) {
      switch (flags.access) {
      case 'read':
        break
      case 'write':
      case 'read-write':
        throw new Error('File is read-only')
      default: {
        const _ex: never = flags.access
        throw new Error(`Unhandled access mode: ${String(_ex)}`)
      }
      }

      return new GeneratedTextFileHandle({
        estimatedSize: size,
        readText: async () => text,
      })
    },
  }
}

function createBinaryObjectDataFileEntry({
  object,
  context,
}: {
  object: NaidanSysfsBinaryObject;
  context: NaidanSysfsContext;
}): NaidanSysfsFileEntry {
  return {
    kind: 'file',
    async stat({ path }: { path: string }) {
      void path
      const blob = await context.reader.getBinaryObjectBlob({ binaryObjectId: object.id })
      if (blob === undefined) {
        throw new Error(`Path not found: data for binary object ${object.id}`)
      }
      return createFileStat({ size: blob.size, mtime: object.createdAt })
    },
    async open({ path, flags }: { path: string; flags: WeshOpenFlags }) {
      if (!canReadBinaryObjectData({ binaryObjectAccess: context.binaryObjectAccess })) {
        throw new Error(`Path not found: ${path}`)
      }

      switch (flags.access) {
      case 'read':
        break
      case 'write':
      case 'read-write':
        throw new Error('File is read-only')
      default: {
        const _ex: never = flags.access
        throw new Error(`Unhandled access mode: ${String(_ex)}`)
      }
      }

      const blob = await context.reader.getBinaryObjectBlob({ binaryObjectId: object.id })
      if (blob === undefined) {
        throw new Error(`Path not found: ${path}`)
      }

      return new BlobFileHandle({
        blob,
        metadata: object,
      })
    },
  }
}

function createBinaryObjectLeafDirectoryEntry({
  object,
}: {
  object: NaidanSysfsBinaryObject;
}): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat()
    },
    async *readDir({
      path,
      context,
    }: {
      path: string;
      context: NaidanSysfsContext;
    }): AsyncIterable<WeshDirEntry> {
      yield {
        name: NAIDAN_SYSFS_METADATA_JSON_FILE_NAME,
        type: 'file',
        fullPath: `${path}/${NAIDAN_SYSFS_METADATA_JSON_FILE_NAME}`,
      }
      yield {
        name: NAIDAN_SYSFS_METADATA_MARKDOWN_FILE_NAME,
        type: 'file',
        fullPath: `${path}/${NAIDAN_SYSFS_METADATA_MARKDOWN_FILE_NAME}`,
      }
      if (canReadBinaryObjectData({ binaryObjectAccess: context.binaryObjectAccess })) {
        yield {
          name: NAIDAN_SYSFS_BINARY_OBJECT_DATA_FILE_NAME,
          type: 'file',
          fullPath: `${path}/${NAIDAN_SYSFS_BINARY_OBJECT_DATA_FILE_NAME}`,
        }
      }
    },
    async getChild({
      name,
      parentPath,
      context,
    }: {
      name: string;
      parentPath: string;
      context: NaidanSysfsContext;
    }): Promise<NaidanSysfsEntry | undefined> {
      void parentPath
      switch (name) {
      case NAIDAN_SYSFS_METADATA_JSON_FILE_NAME:
        return createMetadataFileEntry({ object, fileName: NAIDAN_SYSFS_METADATA_JSON_FILE_NAME })
      case NAIDAN_SYSFS_METADATA_MARKDOWN_FILE_NAME:
        return createMetadataFileEntry({ object, fileName: NAIDAN_SYSFS_METADATA_MARKDOWN_FILE_NAME })
      case NAIDAN_SYSFS_BINARY_OBJECT_DATA_FILE_NAME:
        if (!canReadBinaryObjectData({ binaryObjectAccess: context.binaryObjectAccess })) {
          return undefined
        }
        return createBinaryObjectDataFileEntry({ object, context })
      default:
        return undefined
      }
    },
  }
}

function createBinaryObjectByIdDirectoryEntry(): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat()
    },
    async *readDir({
      path,
      context,
    }: {
      path: string;
      context: NaidanSysfsContext;
    }): AsyncIterable<WeshDirEntry> {
      for await (const object of context.reader.listBinaryObjects()) {
        yield {
          name: object.id,
          type: 'directory',
          fullPath: `${path}/${object.id}`,
        }
      }
    },
    async getChild({
      name,
      parentPath,
      context,
    }: {
      name: string;
      parentPath: string;
      context: NaidanSysfsContext;
    }): Promise<NaidanSysfsEntry | undefined> {
      void parentPath
      const object = await context.reader.getBinaryObject({ binaryObjectId: name })
      if (object === undefined) {
        return undefined
      }
      return createBinaryObjectLeafDirectoryEntry({ object })
    },
  }
}

export function createBinaryObjectsDirectoryEntry(): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat()
    },
    async *readDir({
      path,
      context,
    }: {
      path: string;
      context: NaidanSysfsContext;
    }): AsyncIterable<WeshDirEntry> {
      if (!shouldExposeBinaryObjectsDirectory({ context })) {
        return
      }
      yield {
        name: NAIDAN_SYSFS_BINARY_OBJECTS_BY_ID_DIRECTORY_NAME,
        type: 'directory',
        fullPath: `${path}/${NAIDAN_SYSFS_BINARY_OBJECTS_BY_ID_DIRECTORY_NAME}`,
      }
    },
    async getChild({
      name,
      parentPath,
      context,
    }: {
      name: string;
      parentPath: string;
      context: NaidanSysfsContext;
    }): Promise<NaidanSysfsEntry | undefined> {
      void parentPath
      if (!shouldExposeBinaryObjectsDirectory({ context })) {
        return undefined
      }
      switch (name) {
      case NAIDAN_SYSFS_BINARY_OBJECTS_BY_ID_DIRECTORY_NAME:
        return createBinaryObjectByIdDirectoryEntry()
      default:
        return undefined
      }
    },
  }
}

export function shouldExposeBinaryObjectsDirectory({
  context,
}: {
  context: NaidanSysfsContext;
}): boolean {
  switch (context.binaryObjectAccess) {
  case 'none':
    return false
  case 'metadata_only':
  case 'data':
    return true
  default: {
    const _exhaustive: never = context.binaryObjectAccess
    return _exhaustive
  }
  }
}

export function isBinaryObjectsDirectoryName({
  name,
}: {
  name: string;
}): boolean {
  return name === NAIDAN_SYSFS_BINARY_OBJECTS_DIRECTORY_NAME
}

function canReadBinaryObjectData({
  binaryObjectAccess,
}: {
  binaryObjectAccess: NaidanSysfsBinaryObjectAccess;
}): boolean {
  switch (binaryObjectAccess) {
  case 'none':
  case 'metadata_only':
    return false
  case 'data':
    return true
  default: {
    const _exhaustive: never = binaryObjectAccess
    return _exhaustive
  }
  }
}
