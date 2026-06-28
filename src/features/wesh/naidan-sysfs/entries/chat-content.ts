import type { MessageNode } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';
import type { ChatId } from '@/01-models/ids';
import type { WeshDirEntry, WeshOpenFlags, WeshStat } from '@/features/wesh/types';
import { getChatBranchIterator } from '@/utils/chat-tree';
import { GeneratedTextFileHandle } from '@/features/wesh/naidan-sysfs/generated-text-file-handle';
import { renderMessageJson } from '@/features/wesh/naidan-sysfs/render/message-json';
import { renderMessageMarkdown } from '@/features/wesh/naidan-sysfs/render/message-markdown';
import type { NaidanSysfsContext, NaidanSysfsDirectoryEntry, NaidanSysfsEntry, NaidanSysfsFileEntry } from '@/features/wesh/naidan-sysfs/types';

function createDirectoryStat(): WeshStat {
  return { size: 0, mode: 0o555, type: 'directory', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

function createFileStat({ size }: { size: number }): WeshStat {
  return { size, mode: 0o444, type: 'file', mtime: 0, ino: 0, uid: 0, gid: 0 };
}

function createMessageFileName({ index, node, format }: {
  index: number,
  node: MessageNode,
  format: 'markdown' | 'json',
}): string {
  const extension = (() => {
    switch (format) {
    case 'markdown':
      return 'md';
    case 'json':
      return 'json';
    default: {
      const _ex: never = format;
      throw new Error(`Unhandled content format: ${String(_ex)}`);
    }
    }
  })();
  return `${index + 1}-${node.role}-${idToRaw({ id: node.id })}.${extension}`;
}

async function* loadBranchNodes({
  context,
  chatId,
  path,
}: {
  context: NaidanSysfsContext,
  chatId: ChatId,
  path: string,
}): AsyncGenerator<MessageNode> {
  const chat = await context.reader.loadChat({ chatId });
  if (chat === undefined) {
    throw new Error(`Path not found: ${path}`);
  }

  yield* getChatBranchIterator({ chat });
}

function createMessageFileEntry({
  node,
  format,
}: {
  node: MessageNode,
  format: 'markdown' | 'json',
}): NaidanSysfsFileEntry {
  return {
    kind: 'file',
    async stat({ path }: { path: string }) {
      void path;
      return createFileStat({ size: 4096 });
    },
    async open({
      flags,
    }: {
      path: string,
      flags: WeshOpenFlags,
    }) {
      switch (flags.access) {
      case 'read':
        break;
      case 'write':
      case 'read-write':
        throw new Error('File is read-only');
      default: {
        const _ex: never = flags.access;
        throw new Error(`Unhandled access mode: ${String(_ex)}`);
      }
      }

      return new GeneratedTextFileHandle({
        estimatedSize: 4096,
        readText: async () => {
          switch (format) {
          case 'markdown':
            return renderMessageMarkdown({ node });
          case 'json':
            return `${renderMessageJson({ node })}\n`;
          default: {
            const _ex: never = format;
            throw new Error(`Unhandled content format: ${String(_ex)}`);
          }
          }
        },
      });
    },
  };
}

export function createChatContentDirectoryEntry({
  context,
  chatId,
  format,
}: {
  context: NaidanSysfsContext,
  chatId: ChatId,
  format: 'markdown' | 'json',
}): NaidanSysfsDirectoryEntry {
  return {
    kind: 'directory',
    async stat({ path }: { path: string }) {
      void path;
      return createDirectoryStat();
    },
    async *readDir({
      path,
    }: {
      path: string,
      context: NaidanSysfsContext,
    }): AsyncIterable<WeshDirEntry> {
      let index = 0;
      for await (const node of loadBranchNodes({ context, chatId, path })) {
        const name = createMessageFileName({ index, node, format });
        yield { name, type: 'file', fullPath: `${path}/${name}` };
        index += 1;
      }
    },
    async *readChildren({
      path,
    }: {
      path: string,
      context: NaidanSysfsContext,
    }) {
      let index = 0;
      for await (const node of loadBranchNodes({ context, chatId, path })) {
        const name = createMessageFileName({ index, node, format });
        yield {
          name,
          entry: createMessageFileEntry({ node, format }),
        };
        index += 1;
      }
    },
    async getChild({
      name,
      parentPath,
    }: {
      name: string,
      parentPath: string,
      context: NaidanSysfsContext,
    }): Promise<NaidanSysfsEntry | undefined> {
      let index = 0;
      for await (const node of loadBranchNodes({ context, chatId, path: parentPath })) {
        if (createMessageFileName({ index, node, format }) === name) {
          return createMessageFileEntry({ node, format });
        }
        index += 1;
      }
      return undefined;
    },
  };
}
