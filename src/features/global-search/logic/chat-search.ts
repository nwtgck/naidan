import type { MessageBranch, MessageNode, Role } from '@/01-models/types';
import type { ChatId, MessageId } from '@/01-models/ids';

export interface ContentMatch {
  chatId: ChatId,
  messageId: MessageId,
  excerpt: string,
  role: string,
  targetLeafId: MessageId,
  timestamp: number,
  isCurrentThread: boolean,
}

export type SearchRoleFilter = 'all' | 'user' | 'assistant';

function matchesRoleFilter({ role, roleFilter }: {
  role: Role,
  roleFilter: SearchRoleFilter,
}): boolean {
  switch (roleFilter) {
  case 'all':
    return true;
  case 'user':
  case 'assistant':
    return role === roleFilter;
  default: {
    const _ex: never = roleFilter;
    throw new Error(`Unhandled role filter: ${_ex}`);
  }
  }
}

function getKeywords({ query }: { query: string }): string[] {
  return query.toLowerCase().split(/[\s\u3000]+/).filter(keyword => keyword.length > 0);
}

function getExcerpt({ content, lowerContent, keywords }: {
  content: string,
  lowerContent: string,
  keywords: string[],
}): string {
  const firstKeyword = keywords[0];
  if (firstKeyword === undefined) return content.slice(0, 100);

  const index = lowerContent.indexOf(firstKeyword);
  if (index === -1) return content.slice(0, 100);

  const start = Math.max(0, index - 30);
  const end = Math.min(content.length, index + firstKeyword.length + 50);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

function flattenMessageTree({ root }: { root: MessageBranch }): MessageNode[] {
  const flattened: MessageNode[] = [];
  const stack = [...root.items].reverse();

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;

    flattened.push(node);
    for (let index = node.replies.items.length - 1; index >= 0; index--) {
      const child = node.replies.items[index];
      if (child !== undefined) stack.push(child);
    }
  }

  return flattened;
}

function createDeepestLeafMap({ nodes }: { nodes: MessageNode[] }): Map<MessageNode, MessageNode> {
  const deepestLeafByNode = new Map<MessageNode, MessageNode>();

  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node === undefined) continue;

    const lastChild = node.replies.items[node.replies.items.length - 1];
    deepestLeafByNode.set(
      node,
      lastChild === undefined
        ? node
        : deepestLeafByNode.get(lastChild) ?? lastChild,
    );
  }

  return deepestLeafByNode;
}

function findMatchingBody({ node, keywords }: {
  node: MessageNode,
  keywords: string[],
}): { content: string, lowerContent: string } | undefined {
  // Body search keeps its existing scope: structured reasoning, calls, results,
  // and attachment metadata are not silently added to the searchable text.
  const textParts = node.parts.flatMap(part => {
    switch (part.type) {
    case 'text': return [{ content: part.text, lowerContent: part.text.toLowerCase() }];
    case 'reasoning':
    case 'attachment':
    case 'tool_call':
    case 'tool_result': return [];
    default: {
      const unhandled: never = part;
      throw new Error(`Unhandled search part: ${unhandled}`);
    }
    }
  });
  // Keywords may occur in different body parts, but a single keyword must not
  // be invented by concatenating unrelated part boundaries.
  if (!keywords.every(keyword => textParts.some(part => part.lowerContent.includes(keyword)))) return undefined;
  const firstKeyword = keywords[0];
  return firstKeyword === undefined ? undefined : textParts.find(part => part.lowerContent.includes(firstKeyword));
}

export function searchChatTree({ root, query, chatId, activeBranchIds, roleFilter }: {
  root: MessageBranch,
  query: string,
  chatId: ChatId,
  activeBranchIds?: Set<MessageId>,
  roleFilter?: SearchRoleFilter,
}): ContentMatch[] {
  const keywords = getKeywords({ query });
  if (keywords.length === 0) return [];

  const effectiveRoleFilter = roleFilter ?? 'all';
  const nodes = flattenMessageTree({ root });
  const deepestLeafByNode = createDeepestLeafMap({ nodes });
  const matches: ContentMatch[] = [];

  for (const node of nodes) {
    if (!matchesRoleFilter({ role: node.role, roleFilter: effectiveRoleFilter })) {
      continue;
    }

    const result = findMatchingBody({ node, keywords });
    if (result === undefined) continue;

    const deepestLeaf = deepestLeafByNode.get(node) ?? node;
    matches.push({
      chatId,
      messageId: node.id,
      excerpt: getExcerpt({ content: result.content, lowerContent: result.lowerContent, keywords }),
      role: node.role,
      targetLeafId: deepestLeaf.id,
      timestamp: node.createdAt,
      isCurrentThread: activeBranchIds?.has(node.id) ?? false,
    });
  }

  return matches;
}

export function searchLinearBranch({ branch, query, chatId, targetLeafId, roleFilter }: {
  branch: MessageNode[],
  query: string,
  chatId: ChatId,
  targetLeafId?: MessageId,
  roleFilter?: SearchRoleFilter,
}): ContentMatch[] {
  const keywords = getKeywords({ query });
  if (keywords.length === 0) return [];

  const effectiveRoleFilter = roleFilter ?? 'all';
  const matches: ContentMatch[] = [];

  for (const node of branch) {
    if (!matchesRoleFilter({ role: node.role, roleFilter: effectiveRoleFilter })) {
      continue;
    }

    const result = findMatchingBody({ node, keywords });
    if (result === undefined) continue;

    matches.push({
      chatId,
      messageId: node.id,
      excerpt: getExcerpt({ content: result.content, lowerContent: result.lowerContent, keywords }),
      role: node.role,
      targetLeafId: targetLeafId ?? node.id,
      timestamp: node.createdAt,
      isCurrentThread: true,
    });
  }

  return matches;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
