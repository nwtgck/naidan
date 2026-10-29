import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { useGlobalSearch } from './useGlobalSearch';

describe('useGlobalSearch Composable', () => {
  let search: ReturnType<typeof useGlobalSearch>;

  beforeEach(async () => {
    vi.resetModules();
    search = (await import('./useGlobalSearch')).useGlobalSearch();
    search.closeSearch();
  });

  it('should open search with filters', () => {
    const { isSearchOpen, chatGroupIds, chatId, openSearch } = search;
    openSearch({ groupIds: ['g1'], chatId: 'c1' });
    expect(isSearchOpen.value).toBe(true);
    expect(chatGroupIds.value).toEqual(['g1']);
    expect(chatId.value).toBe('c1');
  });

  it('should reset filters on close', () => {
    const { isSearchOpen, chatGroupIds, chatId, openSearch, closeSearch } = search;
    openSearch({ groupIds: ['g1'], chatId: 'c1' });
    closeSearch();
    expect(isSearchOpen.value).toBe(false);
    expect(chatGroupIds.value).toEqual([]);
    expect(chatId.value).toBeUndefined();
  });

  it('should toggle search state and reset filters when closing', () => {
    const { isSearchOpen, chatGroupIds, openSearch, toggleSearch } = search;
    toggleSearch();
    expect(isSearchOpen.value).toBe(true);

    // Set some filters manually or via openSearch
    openSearch({ groupIds: ['g1'] });

    toggleSearch(); // Should close and reset
    expect(isSearchOpen.value).toBe(false);
    expect(chatGroupIds.value).toEqual([]);
  });

  it('keeps separate queries for global search and each target', () => {
    search.openSearch({});
    search.query.value = 'global';
    search.openSearch({ chatId: 'same' });
    expect(search.query.value).toBe('');
    search.query.value = 'chat';
    search.openSearch({ groupIds: ['same'] });
    expect(search.query.value).toBe('');
    search.query.value = 'group';
    search.openSearch({});
    expect(search.query.value).toBe('global');
    search.openSearch({ chatId: 'same' });
    expect(search.query.value).toBe('chat');
    search.openSearch({ groupIds: ['same'] });
    expect(search.query.value).toBe('group');
  });

  it('remembers raw input immediately across close and a different caller', async () => {
    search.openSearch({ groupIds: ['group'] });
    search.query.value = '  最後の文字  ';
    search.closeSearch();
    const anotherCaller = (await import('./useGlobalSearch')).useGlobalSearch();
    anotherCaller.openSearch({ groupIds: ['group'] });
    expect(anotherCaller.query.value).toBe('  最後の文字  ');
    anotherCaller.query.value = '';
    anotherCaller.closeSearch();
    search.openSearch({ groupIds: ['group'] });
    expect(search.query.value).toBe('');
  });

  it('keeps the opening context fixed when filters change inside the modal', () => {
    search.openSearch({ chatId: 'a' });
    search.query.value = 'before';
    search.chatId.value = undefined;
    search.chatGroupIds.value = ['b'];
    search.query.value = 'after';
    search.closeSearch();
    search.openSearch({ chatId: 'a' });
    expect(search.query.value).toBe('after');
    search.openSearch({ groupIds: ['b'] });
    expect(search.query.value).toBe('');
    search.openSearch({});
    expect(search.query.value).toBe('');
  });

  it('uses global memory when the shortcut opens from another overlay', async () => {
    search.openSearch({});
    search.query.value = 'global';
    search.openSearch({ chatId: 'a' });
    search.query.value = 'chat';
    const { useOverlay } = await import('@/composables/useOverlay');
    useOverlay().openOverlay({ type: 'recent' });
    search.toggleSearch();
    expect(search.isSearchOpen.value).toBe(true);
    expect(search.query.value).toBe('global');
    expect(search.chatId.value).toBeUndefined();
    expect(search.chatGroupIds.value).toEqual([]);
  });

  it('identifies a new opening even while the modal is already open', () => {
    search.openSearch({ chatId: 'a' });
    const previousRequestId = search.searchRequestId.value;
    search.query.value = 'A';
    search.openSearch({ chatId: 'b' });
    expect(search.searchRequestId.value).toBeGreaterThan(previousRequestId);
    expect(search.query.value).toBe('');
    expect(search.isSearchOpen.value).toBe(true);
  });

  it('limits combined target queries to 100 while preserving the global query', () => {
    search.openSearch({});
    search.query.value = 'global';
    for (let index = 0; index < 100; index++) {
      search.openSearch(index % 2 === 0 ? { chatId: String(index) } : { groupIds: [String(index)] });
      search.query.value = `query ${index}`;
    }
    search.openSearch({ chatId: '0' });
    search.openSearch({ chatId: 'extra' });
    search.query.value = 'extra';
    search.openSearch({ groupIds: ['1'] });
    expect(search.query.value).toBe('');
    search.openSearch({ chatId: '0' });
    expect(search.query.value).toBe('query 0');
    search.openSearch({});
    expect(search.query.value).toBe('global');
  });
});
