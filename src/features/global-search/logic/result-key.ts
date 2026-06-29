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
