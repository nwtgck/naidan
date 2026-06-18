import { describe, expect, it } from 'vitest';
import { useExportExclusions } from './useExportExclusions';

describe('useExportExclusions', () => {
  it('builds exclusions in canonical order', () => {
    const state = useExportExclusions();

    expect(state.buildExcludeList()).toEqual([]);

    state.excludeChatHistory.value = true;
    state.excludeAttachments.value = true;
    expect(state.buildExcludeList()).toEqual(['chat_history', 'binary_object']);
  });

  it('makes chat and chat history mutually exclusive', () => {
    const state = useExportExclusions();

    state.excludeChatHistory.value = true;
    state.excludeChats.value = true;

    expect(state.excludeChats.value).toBe(true);
    expect(state.excludeChatHistory.value).toBe(false);
    expect(state.excludeChatHistoryDisabled.value).toBe(true);
    expect(state.buildExcludeList()).toEqual(['chat']);

    state.excludeChats.value = false;
    expect(state.excludeChatHistoryDisabled.value).toBe(false);
    expect(state.excludeChatHistory.value).toBe(false);
  });

  it('does not select chat history while chats are excluded', () => {
    const state = useExportExclusions();

    state.excludeChats.value = true;
    state.excludeChatHistory.value = true;

    expect(state.excludeChatHistory.value).toBe(false);
    expect(state.buildExcludeList()).toEqual(['chat']);
  });
});
