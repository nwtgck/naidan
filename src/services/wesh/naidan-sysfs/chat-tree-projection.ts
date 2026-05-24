import type { Chat, ChatMeta, MessageNode } from '@/models/types'
import { getChatBranchIterator } from '@/utils/chat-tree'
import type { NaidanSysfsContext } from '@/services/wesh/naidan-sysfs/types'

export interface NaidanSysfsLeafBranch {
  leafId: string;
  nodes: MessageNode[];
}

export async function loadSysfsChat({
  context,
  chatId,
  path,
}: {
  context: NaidanSysfsContext;
  chatId: string;
  path: string;
}): Promise<Chat> {
  const metadata = await context.reader.loadChatMeta({ chatId })
  const content = await context.reader.loadChatContent({ chatId })
  if (metadata === undefined || content === undefined) {
    throw new Error(`Path not found: ${path}`)
  }

  return {
    ...metadata,
    root: content.root,
    currentLeafId: resolveActiveLeafId({ metadata, contentCurrentLeafId: content.currentLeafId }),
  }
}

export function resolveActiveLeafId({
  metadata,
  contentCurrentLeafId,
}: {
  metadata: ChatMeta;
  contentCurrentLeafId: string | undefined;
}): string | undefined {
  return contentCurrentLeafId ?? metadata.currentLeafId
}

export function getCurrentBranchNodes({ chat }: { chat: Chat }): MessageNode[] {
  return [...getChatBranchIterator({ chat })]
}

export function* iterateLeafBranches({ chat }: { chat: Chat }): Generator<NaidanSysfsLeafBranch> {
  function* visit({
    nodes,
    ancestors,
  }: {
    nodes: MessageNode[];
    ancestors: MessageNode[];
  }): Generator<NaidanSysfsLeafBranch> {
    for (const node of nodes) {
      const nextAncestors = [...ancestors, node]
      if (node.replies.items.length === 0) {
        yield {
          leafId: node.id,
          nodes: nextAncestors,
        }
        continue
      }
      yield* visit({
        nodes: node.replies.items,
        ancestors: nextAncestors,
      })
    }
  }

  yield* visit({
    nodes: chat.root.items,
    ancestors: [],
  })
}

export function createLeafBranchMap({ chat }: { chat: Chat }): Map<string, NaidanSysfsLeafBranch> {
  return new Map(Array.from(iterateLeafBranches({ chat }), branch => [branch.leafId, branch]))
}
