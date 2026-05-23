import type { ChatMeta } from '@/models/types'
import type { WeshDirEntry, WeshOpenFlags, WeshStat } from '@/services/wesh/types'
import { GeneratedTextFileHandle } from '@/services/wesh/naidan-sysfs/generated-text-file-handle'
import { renderChatMetadataJson } from '@/services/wesh/naidan-sysfs/render/metadata-json'
import { renderChatMetadataMarkdown } from '@/services/wesh/naidan-sysfs/render/metadata-markdown'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsFileEntry } from '@/services/wesh/naidan-sysfs/types'

function createDirectoryStat(_args: Record<never, never>): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createFileStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

async function loadMetadata({
  context,
  chatId,
  path,
}: {
  context: NaidanSysfsContext;
  chatId: string;
  path: string;
}): Promise<ChatMeta> {
  const metadata = await context.reader.loadChatMeta({ chatId })
  if (metadata === undefined) {
    throw new Error(`Path not found: ${path}`)
  }
  return metadata
}

function createMetadataFileEntry({
  context,
  chatId,
  format,
}: {
  context: NaidanSysfsContext;
  chatId: string;
  format: 'md' | 'json';
}): NaidanSysfsFileEntry {
  return {
    kind: 'file',
    async stat({ path }: { path: string }) {
      void path
      return createFileStat({ size: 2048 })
    },
    async open({
      path,
      flags,
    }: {
      path: string;
      flags: WeshOpenFlags;
    }) {
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
        estimatedSize: 2048,
        readText: async () => {
          const metadata = await loadMetadata({ context, chatId, path })
          switch (format) {
          case 'md':
            return renderChatMetadataMarkdown({ metadata })
          case 'json':
            return `${renderChatMetadataJson({ metadata })}\n`
          default: {
            const _ex: never = format
            throw new Error(`Unhandled metadata format: ${String(_ex)}`)
          }
          }
        },
      })
    },
  }
}

export function createChatDirectoryEntry({
  context,
  chatId,
}: {
  context: NaidanSysfsContext;
  chatId: string;
}): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat({})
    },
    async *readDir({ path }: { path: string; context: NaidanSysfsContext }): AsyncIterable<WeshDirEntry> {
      yield { name: 'metadata.md', type: 'file', fullPath: `${path}/metadata.md` }
      yield { name: 'metadata.json', type: 'file', fullPath: `${path}/metadata.json` }
    },
    async getChild({
      name,
      parentPath,
    }: {
      name: string;
      parentPath: string;
      context: NaidanSysfsContext;
    }): Promise<NaidanSysfsEntry | undefined> {
      void parentPath
      switch (name) {
      case 'metadata.md':
        return createMetadataFileEntry({ context, chatId, format: 'md' })
      case 'metadata.json':
        return createMetadataFileEntry({ context, chatId, format: 'json' })
      default:
        return undefined
      }
    },
  }
}
