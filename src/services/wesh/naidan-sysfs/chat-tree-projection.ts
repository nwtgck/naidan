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

export function collectLeafBranches({ chat }: { chat: Chat }): NaidanSysfsLeafBranch[] {
  const leaves: NaidanSysfsLeafBranch[] = []

  const visit = ({
    nodes,
    ancestors,
  }: {
    nodes: MessageNode[];
    ancestors: MessageNode[];
  }): void => {
    for (const node of nodes) {
      const nextAncestors = [...ancestors, node]
      if (node.replies.items.length === 0) {
        leaves.push({
          leafId: node.id,
          nodes: nextAncestors,
        })
        continue
      }
      visit({
        nodes: node.replies.items,
        ancestors: nextAncestors,
      })
    }
  }

  visit({
    nodes: chat.root.items,
    ancestors: [],
  })

  return leaves
}

export function createLeafBranchMap({ chat }: { chat: Chat }): Map<string, NaidanSysfsLeafBranch> {
  return new Map(collectLeafBranches({ chat }).map(branch => [branch.leafId, branch]))
}
