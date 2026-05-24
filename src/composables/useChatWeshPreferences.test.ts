import { beforeEach, describe, expect, it } from 'vitest';
import { useChatWeshPreferences } from './useChatWeshPreferences';

describe('useChatWeshPreferences', () => {
  beforeEach(() => {
    useChatWeshPreferences().TEST_ONLY.naidanSysfsMountSelectionByChat.value = new Map();
  });

  it('defaults to none when a chat has no explicit selection', () => {
    const { getNaidanSysfsMountSelection } = useChatWeshPreferences();
    expect(getNaidanSysfsMountSelection({ chatId: 'chat-1' })).toBe('none');
  });

  it('stores selection per chat in memory', () => {
    const { getNaidanSysfsMountSelection, setNaidanSysfsMountSelection } = useChatWeshPreferences();

    setNaidanSysfsMountSelection({ chatId: 'chat-1', selection: 'current_chat_only' });
    setNaidanSysfsMountSelection({ chatId: 'chat-2', selection: 'all_chats' });

    expect(getNaidanSysfsMountSelection({ chatId: 'chat-1' })).toBe('current_chat_only');
    expect(getNaidanSysfsMountSelection({ chatId: 'chat-2' })).toBe('all_chats');
  });

  it('returns none when chatId is undefined', () => {
    const { getNaidanSysfsMountSelection } = useChatWeshPreferences();
    expect(getNaidanSysfsMountSelection({ chatId: undefined })).toBe('none');
  });
});
