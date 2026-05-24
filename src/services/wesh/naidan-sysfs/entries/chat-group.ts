import type { ChatGroup } from '@/models/types'
import { NAIDAN_SYSFS_ROOT_PATH } from '@/services/wesh/naidan-sysfs/constants'
import { GeneratedTextFileHandle } from '@/services/wesh/naidan-sysfs/generated-text-file-handle'
import { renderChatGroupMetadataMarkdown } from '@/services/wesh/naidan-sysfs/render/chat-group-metadata-markdown'
import { renderChatGroupMetadataJson } from '@/services/wesh/naidan-sysfs/render/chat-group-metadata-json'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsFileEntry, NaidanSysfsRestrictedDirectoryEntry, NaidanSysfsSymlinkEntry } from '@/services/wesh/naidan-sysfs/types'
import type { WeshDirEntry, WeshOpenFlags, WeshStat } from '@/services/wesh/types'

function createDirectoryStat(_args: Record<never, never>): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createFileStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createRestrictedDirectoryStat(_args: Record<never, never>): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createChatGroupMetadataFileEntry({
  chatGroup,
  format,
}: {
  chatGroup: ChatGroup;
  format: 'md' | 'json';
}): NaidanSysfsFileEntry {
  return {
    kind: 'file',
    async stat({ path }: { path: string }) {
      void path
      return createFileStat({ size: 2048 })
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
        estimatedSize: 2048,
        readText: async () => {
          switch (format) {
          case 'md':
            return renderChatGroupMetadataMarkdown({ chatGroup })
          case 'json':
            return `${renderChatGroupMetadataJson({ chatGroup })}\n`
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

function createRestrictedChatsDirectoryEntry(_args: Record<never, never>): NaidanSysfsRestrictedDirectoryEntry {
  return {
    kind: 'restricted-directory',
    async stat({ path }: { path: string }) {
      void path
      return createRestrictedDirectoryStat({})
    },
    async *readDir({ path }: { path: string }): AsyncIterable<WeshDirEntry> {
      yield* []
      throw new Error(`Permission denied: ${path}`)
    },
  }
}

function createChatGroupChatSymlinkEntry({ chatId }: { chatId: string }): NaidanSysfsSymlinkEntry {
  return {
    kind: 'symlink',
    async stat({ path }: { path: string }) {
      void path
      return { size: `${NAIDAN_SYSFS_ROOT_PATH}/chats/${chatId}`.length, mode: 0o777, type: 'symlink', mtime: 0, ino: 0, uid: 0, gid: 0 }
    },
    async readlink({ path }: { path: string }) {
      void path
      return `${NAIDAN_SYSFS_ROOT_PATH}/chats/${chatId}`
    },
  }
}

function createChatGroupChatsDirectoryEntry({
  context,
  chatGroup,
}: {
  context: NaidanSysfsContext;
  chatGroup: ChatGroup;
}): NaidanSysfsDirectoryEntry | NaidanSysfsRestrictedDirectoryEntry {
  switch (context.visibility) {
  case 'current_chat_only':
    return createRestrictedChatsDirectoryEntry({})
  case 'current_chat_with_chat_group':
  case 'all_chats':
    return {
      kind: 'directory',
      async stat({ path }: { path: string }) {
        void path
        return createDirectoryStat({})
      },
      async *readDir({
        path,
      }: {
        path: string;
        context: NaidanSysfsContext;
      }): AsyncIterable<WeshDirEntry> {
        for (const item of chatGroup.items) {
          yield {
            name: item.chat.id,
            type: 'symlink',
            fullPath: `${path}/${item.chat.id}`,
          }
        }
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
        if (!chatGroup.items.some(item => item.chat.id === name)) {
          return undefined
        }
        return createChatGroupChatSymlinkEntry({ chatId: name })
      },
    }
  default: {
    const _ex: never = context.visibility
    throw new Error(`Unhandled visibility: ${String(_ex)}`)
  }
  }
}

export function createChatGroupDirectoryEntry({
  context,
  chatGroup,
}: {
  context: NaidanSysfsContext;
  chatGroup: ChatGroup;
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
      yield { name: 'chats', type: 'directory', fullPath: `${path}/chats` }
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
        return createChatGroupMetadataFileEntry({ chatGroup, format: 'md' })
      case 'metadata.json':
        return createChatGroupMetadataFileEntry({ chatGroup, format: 'json' })
      case 'chats':
        return createChatGroupChatsDirectoryEntry({ context, chatGroup })
      default:
        return undefined
      }
    },
  }
}
