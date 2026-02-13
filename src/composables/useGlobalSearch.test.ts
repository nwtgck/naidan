import { describe, it, expect, beforeEach } from 'vitest';
import { useGlobalSearch } from './useGlobalSearch';

describe('useGlobalSearch Composable', () => {
  const { isSearchOpen, chatGroupIds, chatId, openSearch, closeSearch, toggleSearch } = useGlobalSearch();

  beforeEach(() => {
    closeSearch();
  });

  it('should open search with filters', () => {
    openSearch({ groupIds: ['g1'], chatId: 'c1' });
    expect(isSearchOpen.value).toBe(true);
    expect(chatGroupIds.value).toEqual(['g1']);
    expect(chatId.value).toBe('c1');
  });

  it('should reset filters on close', () => {
    openSearch({ groupIds: ['g1'], chatId: 'c1' });
    closeSearch();
    expect(isSearchOpen.value).toBe(false);
    expect(chatGroupIds.value).toEqual([]);
    expect(chatId.value).toBeUndefined();
  });

  it('should toggle search state and reset filters when closing', () => {
    toggleSearch();
    expect(isSearchOpen.value).toBe(true);
    
    // Set some filters manually or via openSearch
    openSearch({ groupIds: ['g1'] });
    
    toggleSearch(); // Should close and reset
    expect(isSearchOpen.value).toBe(false);
    expect(chatGroupIds.value).toEqual([]);
  });
});
