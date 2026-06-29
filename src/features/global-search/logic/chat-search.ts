import type { MessageBranch, MessageNode, Role } from '@/01-models/types';
import type { ChatId, MessageId } from '@/01-models/ids';
import { findDeepestLeaf } from '@/utils/chat-tree';

export interface ContentMatch {
  chatId: ChatId,
  messageId: MessageId,
  excerpt: string,
  fullContent: string,
  role: string,
  targetLeafId: MessageId,
  timestamp: number,
  isCurrentThread: boolean,
}

export type SearchRoleFilter = 'all' | 'user' | 'assistant';

function matchesRoleFilter({ role, roleFilter }: {
  role: Role,
  roleFilter: SearchRoleFilter,
}) {
  switch (roleFilter) {
  case 'all':
    return true;
  case 'user':
  case 'assistant':
    return role === roleFilter;
  default: {
    const _exhaustiveCheck: never = roleFilter;
    throw new Error(`Unhandled role filter: ${_exhaustiveCheck}`);
  }
  }
}

/**
 * Recursively searches for text within a message tree, including all branches.
 * Returns all matches found.
 *
 * @param params.root The root branch to search
 * @param params.query The search query (can be multiple words)
 * @param params.chatId The ID of the chat being searched
 * @param params.activeBranchIds Set of message IDs that are in the active thread (optional)
 */
export function searchChatTree({ root, query, chatId, activeBranchIds, roleFilter }: {
  root: MessageBranch,
  query: string,
  chatId: ChatId,
  activeBranchIds?: Set<MessageId>,
  roleFilter?: SearchRoleFilter,
}): ContentMatch[] {
  const matches: ContentMatch[] = [];
  const keywords = query.toLowerCase().split(/[\s\u3000]+/).filter(k => k.length > 0);
  const effectiveRoleFilter = roleFilter ?? 'all';

  if (keywords.length === 0) return [];

  function traverse({ items }: { items: MessageNode[] }) {
    for (const node of items) {
      // Check current node
      if (node.content && matchesRoleFilter({ role: node.role, roleFilter: effectiveRoleFilter })) {
        const lowerContent = node.content.toLowerCase();
        const allMatch = keywords.every(k => lowerContent.includes(k));

        if (allMatch) {
          // Find the deepest leaf from this node to ensure it appears in the active path
          const leafNode = findDeepestLeaf({ node });

          matches.push({
            chatId,
            messageId: node.id,
            excerpt: getExcerpt({ content: node.content, keywords }),
            fullContent: node.content,
            role: node.role,
            targetLeafId: leafNode.id,
            timestamp: node.timestamp,
            isCurrentThread: activeBranchIds ? activeBranchIds.has(node.id) : false,
          });
        }
      }

      // Recurse into replies
      if (node.replies && node.replies.items.length > 0) {
        traverse({ items: node.replies.items });
      }
    }
  }

  traverse({ items: root.items });
  return matches;
}

/**
 * Extracts a relevant excerpt around the match.
 */
function getExcerpt({ content, keywords }: { content: string, keywords: string[] }): string {
  const lowerContent = content.toLowerCase();
  // Use the first keyword for positioning the excerpt
  const firstKeyword = keywords[0];
  if (!firstKeyword) return content.slice(0, 100);

  const index = lowerContent.indexOf(firstKeyword);
  if (index === -1) return content.slice(0, 100);

  const start = Math.max(0, index - 30);
  const end = Math.min(content.length, index + firstKeyword.length + 50);

  let text = content.slice(start, end);
  if (start > 0) text = '...' + text;
  if (end < content.length) text = text + '...';

  return text;
}

/**
 * Searches within a specific linear sequence of messages (e.g. the active conversation path).
 * Does not recurse into side branches.
 */
export function searchLinearBranch({ branch, query, chatId, targetLeafId, roleFilter }: {
  branch: MessageNode[],
  query: string,
  chatId: ChatId,
  targetLeafId?: MessageId,
  roleFilter?: SearchRoleFilter,
}): ContentMatch[] {
  const matches: ContentMatch[] = [];
  const keywords = query.toLowerCase().split(/[\s\u3000]+/).filter(k => k.length > 0);
  const effectiveRoleFilter = roleFilter ?? 'all';

  if (keywords.length === 0) return [];

  for (const node of branch) {
    if (node.content && matchesRoleFilter({ role: node.role, roleFilter: effectiveRoleFilter })) {
      const lowerContent = node.content.toLowerCase();
      const allMatch = keywords.every(k => lowerContent.includes(k));

      if (allMatch) {
        matches.push({
          chatId,
          messageId: node.id,
          excerpt: getExcerpt({ content: node.content, keywords }),
          fullContent: node.content,
          role: node.role,
          targetLeafId: targetLeafId || node.id,
          timestamp: node.timestamp,
          isCurrentThread: true,
        });
      }
    }
  }
  return matches;
}
