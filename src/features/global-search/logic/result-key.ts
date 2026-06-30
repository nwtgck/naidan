import type { FlatSearchResultItem } from '@/features/global-search/types';

export function getSearchResultKey({
  entry,
}: {
  entry: FlatSearchResultItem,
}): string {
  switch (entry.type) {
  case 'chat_group':
    return `chat-group:${entry.item.groupId}`;
  case 'chat':
    return `chat:${entry.item.chatId}`;
  case 'message':
    return `message:${entry.item.chatId}:${entry.item.messageId}`;
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled search result type: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
