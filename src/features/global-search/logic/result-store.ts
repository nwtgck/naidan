import { UNTITLED_CHAT_TITLE } from '@/constants';
import type {
  ContentMatch,
  FlatSearchResultItem,
  SearchChatSource,
  SearchResultItem,
} from '@/features/global-search/types';

type ChatResult = Extract<SearchResultItem, { type: 'chat' }>;

export interface SearchResultStore {
  addContentMatches({
    source,
    matches,
  }: {
    source: SearchChatSource,
    matches: ContentMatch[],
  }): void;

  toFlatResults(): FlatSearchResultItem[];
}

export function createSearchResultStore({
  titleResults,
}: {
  titleResults: FlatSearchResultItem[],
}): SearchResultStore {
  const titleChatHeaders = new Map<string, ChatResult>();
  const contentMatchesByChatId = new Map<string, ContentMatch[]>();
  const contentOnlyChatOrder: string[] = [];
  const contentOnlyChatHeaders = new Map<string, ChatResult>();

  for (const entry of titleResults) {
    switch (entry.type) {
    case 'chat':
      titleChatHeaders.set(entry.item.chatId, entry.item);
      break;
    case 'chat_group':
    case 'message':
      break;
    default: {
      const _ex: never = entry;
      throw new Error(
        `Unhandled search result type: ${((_ex satisfies never) as { readonly type: string }).type}`,
      );
    }
    }
  }

  return {
    addContentMatches({ source, matches }) {
      if (matches.length === 0) return;

      const chatId = source.chat.id;
      contentMatchesByChatId.set(chatId, matches);

      const titleHeader = titleChatHeaders.get(chatId);
      if (titleHeader !== undefined) {
        titleHeader.matchType = 'both';
        titleHeader.contentMatches = matches;
        return;
      }

      if (!contentOnlyChatHeaders.has(chatId)) {
        contentOnlyChatOrder.push(chatId);
        contentOnlyChatHeaders.set(chatId, {
          type: 'chat',
          chatId,
          title: source.chat.title || UNTITLED_CHAT_TITLE,
          groupId: source.chat.groupId,
          groupName: source.groupName,
          updatedAt: source.chat.updatedAt,
          matchType: 'content',
          titleMatch: false,
          contentMatches: matches,
        });
      }
    },

    toFlatResults() {
      const flatResults: FlatSearchResultItem[] = [];

      for (const entry of titleResults) {
        flatResults.push(entry);
        switch (entry.type) {
        case 'chat': {
          const matches = contentMatchesByChatId.get(entry.item.chatId);
          if (matches === undefined) break;

          for (const match of matches) {
            flatResults.push({
              type: 'message',
              item: match,
            });
          }
          break;
        }
        case 'chat_group':
        case 'message':
          break;
        default: {
          const _ex: never = entry;
          throw new Error(
            `Unhandled search result type: ${((_ex satisfies never) as { readonly type: string }).type}`,
          );
        }
        }
      }

      for (const chatId of contentOnlyChatOrder) {
        const header = contentOnlyChatHeaders.get(chatId);
        const matches = contentMatchesByChatId.get(chatId);
        if (header === undefined || matches === undefined) continue;

        flatResults.push({ type: 'chat', item: header });
        for (const match of matches) {
          flatResults.push({
            type: 'message',
            item: match,
          });
        }
      }

      return flatResults;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
