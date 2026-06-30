import { describe, expect, it } from 'vitest';
import { createSearchResultStore } from './result-store';
import type {
  ContentMatch,
  FlatSearchResultItem,
  SearchChatSource,
} from '@/features/global-search/types';

function createMatch({ chatId, messageId }: {
  chatId: string,
  messageId: string,
}): ContentMatch {
  return {
    chatId,
    messageId,
    excerpt: `match ${messageId}`,
    role: 'user',
    targetLeafId: messageId,
    timestamp: 1,
    isCurrentThread: true,
  };
}

function createSource({ id, title }: {
  id: string,
  title: string,
}): SearchChatSource {
  return {
    chat: {
      id,
      title,
      updatedAt: 1,
    },
  };
}

describe('createSearchResultStore', () => {
  it('places content matches directly after a title-matched chat', () => {
    const titleResults: FlatSearchResultItem[] = [
      {
        type: 'chat',
        item: {
          type: 'chat',
          chatId: 'chat-1',
          title: 'Title match',
          updatedAt: 1,
          matchType: 'title',
          titleMatch: true,
          contentMatches: [],
        },
      },
      {
        type: 'chat',
        item: {
          type: 'chat',
          chatId: 'chat-2',
          title: 'Second title match',
          updatedAt: 2,
          matchType: 'title',
          titleMatch: true,
          contentMatches: [],
        },
      },
    ];
    const store = createSearchResultStore({ titleResults });
    const matches = [createMatch({ chatId: 'chat-1', messageId: 'message-1' })];

    store.addContentMatches({
      source: createSource({ id: 'chat-1', title: 'Title match' }),
      matches,
    });

    const results = store.toFlatResults();
    expect(results.map(result => result.type)).toEqual(['chat', 'message', 'chat']);
    expect(results[0]?.type === 'chat' && results[0].item.matchType).toBe('both');
    expect(results[1]?.type === 'message' && results[1].item.messageId).toBe('message-1');
  });

  it('appends content-only chats in scanning order', () => {
    const store = createSearchResultStore({ titleResults: [] });

    store.addContentMatches({
      source: createSource({ id: 'chat-2', title: 'Second' }),
      matches: [createMatch({ chatId: 'chat-2', messageId: 'message-2' })],
    });
    store.addContentMatches({
      source: createSource({ id: 'chat-1', title: 'First' }),
      matches: [createMatch({ chatId: 'chat-1', messageId: 'message-1' })],
    });

    const results = store.toFlatResults();
    expect(results.map(result => result.type)).toEqual(['chat', 'message', 'chat', 'message']);
    expect(results[0]?.type === 'chat' && results[0].item.chatId).toBe('chat-2');
    expect(results[2]?.type === 'chat' && results[2].item.chatId).toBe('chat-1');
  });
});
