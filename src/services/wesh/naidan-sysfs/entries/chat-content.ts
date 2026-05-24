import type { MessageNode } from '@/models/types'
import type { WeshDirEntry, WeshOpenFlags, WeshStat } from '@/services/wesh/types'
import { getChatBranchIterator } from '@/utils/chat-tree'
import { GeneratedTextFileHandle } from '@/services/wesh/naidan-sysfs/generated-text-file-handle'
import { renderMessageJson } from '@/services/wesh/naidan-sysfs/render/message-json'
import { renderMessageMarkdown } from '@/services/wesh/naidan-sysfs/render/message-markdown'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsFileEntry } from '@/services/wesh/naidan-sysfs/types'

function createDirectoryStat(_args: Record<never, never>): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createFileStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createMessageFileName({ index, node, format }: {
  index: number;
  node: MessageNode;
  format: 'md' | 'json';
}): string {
  return `${String(index + 1).padStart(4, '0')}-${node.role}.${format}`
}

async function loadBranchNodes({
  context,
  chatId,
  path,
}: {
  context: NaidanSysfsContext;
  chatId: string;
  path: string;
}): Promise<MessageNode[]> {
  const metadata = await context.reader.loadChatMeta({ chatId })
  const content = await context.reader.loadChatContent({ chatId })
  if (metadata === undefined || content === undefined) {
    throw new Error(`Path not found: ${path}`)
  }

  const chat = {
    ...metadata,
    root: content.root,
    currentLeafId: content.currentLeafId ?? metadata.currentLeafId,
  }

  return [...getChatBranchIterator({ chat })]
}

function createMessageFileEntry({
  node,
  format,
}: {
  node: MessageNode;
  format: 'md' | 'json';
}): NaidanSysfsFileEntry {
  return {
    kind: 'file',
    async stat({ path }: { path: string }) {
      void path
      return createFileStat({ size: 4096 })
    },
    async open({
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
        estimatedSize: 4096,
        readText: async () => {
          switch (format) {
          case 'md':
            return renderMessageMarkdown({ node })
          case 'json':
            return `${renderMessageJson({ node })}\n`
          default: {
            const _ex: never = format
            throw new Error(`Unhandled content format: ${String(_ex)}`)
          }
          }
        },
      })
    },
  }
}

export function createChatContentDirectoryEntry({
  context,
  chatId,
  format,
}: {
  context: NaidanSysfsContext;
  chatId: string;
  format: 'md' | 'json';
}): NaidanSysfsDirectoryEntry {
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
      const nodes = await loadBranchNodes({ context, chatId, path })
      for (const [index, node] of nodes.entries()) {
        const name = createMessageFileName({ index, node, format })
        yield { name, type: 'file', fullPath: `${path}/${name}` }
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
      const nodes = await loadBranchNodes({ context, chatId, path: parentPath })
      for (const [index, node] of nodes.entries()) {
        if (createMessageFileName({ index, node, format }) === name) {
          return createMessageFileEntry({ node, format })
        }
      }
      return undefined
    },
  }
}
