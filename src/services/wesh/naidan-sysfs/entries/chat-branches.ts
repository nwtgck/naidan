import type { Chat, MessageNode } from '@/models/types'
import { GeneratedTextFileHandle } from '@/services/wesh/naidan-sysfs/generated-text-file-handle'
import { createLeafBranchMap, getCurrentBranchNodes, loadSysfsChat, type NaidanSysfsLeafBranch } from '@/services/wesh/naidan-sysfs/chat-tree-projection'
import { renderLeafMetadataJson } from '@/services/wesh/naidan-sysfs/render/leaf-metadata-json'
import { renderLeafMetadataMarkdown } from '@/services/wesh/naidan-sysfs/render/leaf-metadata-markdown'
import { renderMessageJson } from '@/services/wesh/naidan-sysfs/render/message-json'
import { renderMessageMarkdown } from '@/services/wesh/naidan-sysfs/render/message-markdown'
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsFileEntry, NaidanSysfsSymlinkEntry } from '@/services/wesh/naidan-sysfs/types'
import { NAIDAN_SYSFS_ROOT_PATH } from '@/services/wesh/naidan-sysfs/constants'
import type { WeshDirEntry, WeshOpenFlags, WeshStat } from '@/services/wesh/types'

type NaidanSysfsBranchFormat = 'md' | 'json'

function createDirectoryStat(_args: Record<never, never>): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createFileStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function createSymlinkStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o777, type: 'symlink', mtime: 0, ino: 0, uid: 0, gid: 0 }
}

function assertReadOnlyOpen({ flags }: { flags: WeshOpenFlags }): void {
  switch (flags.access) {
  case 'read':
    return
  case 'write':
  case 'read-write':
    throw new Error('File is read-only')
  default: {
    const _ex: never = flags.access
    throw new Error(`Unhandled access mode: ${String(_ex)}`)
  }
  }
}

function createMessageFileName({
  index,
  node,
  format,
}: {
  index: number;
  node: MessageNode;
  format: NaidanSysfsBranchFormat;
}): string {
  return `${index}-${node.role}-${node.id}.${format}`
}

function createBranchDirectoryName({
  index,
  branchIndex,
}: {
  index: number;
  branchIndex: number;
}): string {
  return `${index}-branch-${branchIndex}`
}

function createLeafSymlinkTarget({
  chatId,
  format,
  leafId,
}: {
  chatId: string;
  format: NaidanSysfsBranchFormat;
  leafId: string;
}): string {
  return `${NAIDAN_SYSFS_ROOT_PATH}/chats/${chatId}/branches/leaves-${format}/${leafId}`
}

function createGeneratedFileEntry({
  estimatedSize,
  readText,
}: {
  estimatedSize: number;
  readText: () => Promise<string>;
}): NaidanSysfsFileEntry {
  return {
    kind: 'file',
    async stat({ path }: { path: string }) {
      void path
      return createFileStat({ size: estimatedSize })
    },
    async open({
      flags,
    }: {
      path: string;
      flags: WeshOpenFlags;
    }) {
      assertReadOnlyOpen({ flags })
      return new GeneratedTextFileHandle({
        estimatedSize,
        readText,
      })
    },
  }
}

function collectLinearChain({
  nodes,
}: {
  nodes: MessageNode[];
}): {
  chain: MessageNode[];
  nextNodes: MessageNode[];
} {
  const chain: MessageNode[] = []
  let cursor = nodes

  while (cursor.length === 1) {
    const node = cursor[0]!
    chain.push(node)
    cursor = node.replies.items
  }

  return {
    chain,
    nextNodes: cursor,
  }
}

function createTreeBranchSymlinkEntry({
  chatId,
  format,
  leafId,
}: {
  chatId: string;
  format: NaidanSysfsBranchFormat;
  leafId: string;
}): NaidanSysfsSymlinkEntry {
  const targetPath = createLeafSymlinkTarget({ chatId, format, leafId })
  return {
    kind: 'symlink',
    async stat({ path }: { path: string }) {
      void path
      return createSymlinkStat({ size: targetPath.length })
    },
    async readlink({ path }: { path: string }) {
      void path
      return targetPath
    },
  }
}

function createMessageContent({
  node,
  format,
}: {
  node: MessageNode;
  format: NaidanSysfsBranchFormat;
}): string {
  switch (format) {
  case 'md':
    return renderMessageMarkdown({ node })
  case 'json':
    return `${renderMessageJson({ node })}\n`
  default: {
    const _ex: never = format
    throw new Error(`Unhandled branch format: ${String(_ex)}`)
  }
  }
}

function createLeafMetadataEntry({
  chat,
  leafId,
  nodes,
  format,
}: {
  chat: Chat;
  leafId: string;
  nodes: MessageNode[];
  format: NaidanSysfsBranchFormat;
}): NaidanSysfsFileEntry {
  return createGeneratedFileEntry({
    estimatedSize: 2048,
    readText: async () => {
      switch (format) {
      case 'md':
        return renderLeafMetadataMarkdown({ chat, leafId, nodes })
      case 'json':
        return `${renderLeafMetadataJson({ chat, leafId, nodes })}\n`
      default: {
        const _ex: never = format
        throw new Error(`Unhandled branch format: ${String(_ex)}`)
      }
      }
    },
  })
}

function createLeafContentDirectoryEntry({
  nodes,
  format,
}: {
  nodes: MessageNode[];
  format: NaidanSysfsBranchFormat;
}): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat({})
    },
    async *readDir({ path }: { path: string; context: NaidanSysfsContext }): AsyncIterable<WeshDirEntry> {
      for (const [index, node] of nodes.entries()) {
        const name = createMessageFileName({ index: index + 1, node, format })
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
      void parentPath
      for (const [index, node] of nodes.entries()) {
        const fileName = createMessageFileName({ index: index + 1, node, format })
        if (fileName === name) {
          return createGeneratedFileEntry({
            estimatedSize: 4096,
            readText: async () => createMessageContent({ node, format }),
          })
        }
      }
      return undefined
    },
  }
}

function createLeafDirectoryEntry({
  chat,
  leafBranch,
  format,
}: {
  chat: Chat;
  leafBranch: NaidanSysfsLeafBranch;
  format: NaidanSysfsBranchFormat;
}): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat({})
    },
    async *readDir({ path }: { path: string; context: NaidanSysfsContext }): AsyncIterable<WeshDirEntry> {
      yield { name: `metadata.${format}`, type: 'file', fullPath: `${path}/metadata.${format}` }
      yield { name: 'content', type: 'directory', fullPath: `${path}/content` }
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
      if (name === `metadata.${format}`) {
        return createLeafMetadataEntry({
          chat,
          leafId: leafBranch.leafId,
          nodes: leafBranch.nodes,
          format,
        })
      }
      if (name === 'content') {
        return createLeafContentDirectoryEntry({
          nodes: leafBranch.nodes,
          format,
        })
      }
      return undefined
    },
  }
}

function createLeavesDirectoryEntry({
  context,
  chatId,
  format,
}: {
  context: NaidanSysfsContext;
  chatId: string;
  format: NaidanSysfsBranchFormat;
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
      const chat = await loadSysfsChat({ context, chatId, path })
      for (const { leafId } of createLeafBranchMap({ chat }).values()) {
        yield { name: leafId, type: 'directory', fullPath: `${path}/${leafId}` }
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
      const chat = await loadSysfsChat({ context, chatId, path: parentPath })
      const leafBranch = createLeafBranchMap({ chat }).get(name)
      if (leafBranch === undefined) {
        return undefined
      }
      return createLeafDirectoryEntry({ chat, leafBranch, format })
    },
  }
}

function createCurrentBranchSymlinkEntry({
  context,
  chatId,
  format,
}: {
  context: NaidanSysfsContext;
  chatId: string;
  format: NaidanSysfsBranchFormat;
}): NaidanSysfsSymlinkEntry {
  return {
    kind: 'symlink',
    async stat({ path }: { path: string }) {
      const chat = await loadSysfsChat({ context, chatId, path })
      const currentBranch = getCurrentBranchNodes({ chat })
      const leafId = currentBranch.at(-1)?.id
      if (leafId === undefined) {
        throw new Error(`Path not found: ${path}`)
      }
      return createSymlinkStat({
        size: createLeafSymlinkTarget({ chatId, format, leafId }).length,
      })
    },
    async readlink({ path }: { path: string }) {
      const chat = await loadSysfsChat({ context, chatId, path })
      const currentBranch = getCurrentBranchNodes({ chat })
      const leafId = currentBranch.at(-1)?.id
      if (leafId === undefined) {
        throw new Error(`Path not found: ${path}`)
      }
      return createLeafSymlinkTarget({ chatId, format, leafId })
    },
  }
}

function createTreeDirectoryEntry({
  chatId,
  format,
  nodes,
  sequenceStart,
}: {
  chatId: string;
  format: NaidanSysfsBranchFormat;
  nodes: MessageNode[];
  sequenceStart: number;
}): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path
      return createDirectoryStat({})
    },
    async *readDir({ path }: { path: string; context: NaidanSysfsContext }): AsyncIterable<WeshDirEntry> {
      const { chain, nextNodes } = collectLinearChain({ nodes })
      for (const [index, node] of chain.entries()) {
        const fileName = createMessageFileName({ index: sequenceStart + index, node, format })
        yield { name: fileName, type: 'file', fullPath: `${path}/${fileName}` }
      }

      const nextSequence = sequenceStart + chain.length
      if (nextNodes.length === 0 && chain.length > 0) {
        yield { name: 'branch', type: 'symlink', fullPath: `${path}/branch` }
        return
      }

      for (const [branchIndex] of nextNodes.entries()) {
        const name = createBranchDirectoryName({
          index: nextSequence,
          branchIndex: branchIndex + 1,
        })
        yield { name, type: 'directory', fullPath: `${path}/${name}` }
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
      const { chain, nextNodes } = collectLinearChain({ nodes })
      for (const [index, node] of chain.entries()) {
        const fileName = createMessageFileName({ index: sequenceStart + index, node, format })
        if (fileName === name) {
          return createGeneratedFileEntry({
            estimatedSize: 4096,
            readText: async () => createMessageContent({ node, format }),
          })
        }
      }

      const nextSequence = sequenceStart + chain.length
      if (name === 'branch' && nextNodes.length === 0 && chain.length > 0) {
        const leafId = chain.at(-1)?.id
        if (leafId === undefined) {
          return undefined
        }
        return createTreeBranchSymlinkEntry({ chatId, format, leafId })
      }

      for (const [branchIndex, node] of nextNodes.entries()) {
        const branchName = createBranchDirectoryName({
          index: nextSequence,
          branchIndex: branchIndex + 1,
        })
        if (branchName === name) {
          return createTreeDirectoryEntry({
            chatId,
            format,
            nodes: [node],
            sequenceStart: nextSequence,
          })
        }
      }

      void parentPath
      return undefined
    },
  }
}

export function createChatBranchesDirectoryEntry({
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
      yield { name: 'current-md', type: 'symlink', fullPath: `${path}/current-md` }
      yield { name: 'current-json', type: 'symlink', fullPath: `${path}/current-json` }
      yield { name: 'tree-md', type: 'directory', fullPath: `${path}/tree-md` }
      yield { name: 'tree-json', type: 'directory', fullPath: `${path}/tree-json` }
      yield { name: 'leaves-md', type: 'directory', fullPath: `${path}/leaves-md` }
      yield { name: 'leaves-json', type: 'directory', fullPath: `${path}/leaves-json` }
    },
    async getChild({
      name,
      parentPath,
    }: {
      name: string;
      parentPath: string;
      context: NaidanSysfsContext;
    }): Promise<NaidanSysfsEntry | undefined> {
      switch (name) {
      case 'current-md':
        return createCurrentBranchSymlinkEntry({ context, chatId, format: 'md' })
      case 'current-json':
        return createCurrentBranchSymlinkEntry({ context, chatId, format: 'json' })
      case 'tree-md': {
        const chat = await loadSysfsChat({ context, chatId, path: `${parentPath}/${name}` })
        return createTreeDirectoryEntry({ chatId, format: 'md', nodes: chat.root.items, sequenceStart: 1 })
      }
      case 'tree-json': {
        const chat = await loadSysfsChat({ context, chatId, path: `${parentPath}/${name}` })
        return createTreeDirectoryEntry({ chatId, format: 'json', nodes: chat.root.items, sequenceStart: 1 })
      }
      case 'leaves-md':
        return createLeavesDirectoryEntry({ context, chatId, format: 'md' })
      case 'leaves-json':
        return createLeavesDirectoryEntry({ context, chatId, format: 'json' })
      default:
        return undefined
      }
    },
  }
}
