import { describe, expect, it } from 'vitest';
import { createSearchQueryMemory } from './query-memory';

describe('search query memory', () => {
  it('separates global, chat and chat group queries even when IDs match', () => {
    const memory = createSearchQueryMemory({ targetLimit: 2 });
    memory.rememberQuery({ context: { type: 'global' }, query: 'global' });
    memory.rememberQuery({ context: { type: 'chat', chatId: 'same' }, query: '  予約  ' });
    memory.rememberQuery({ context: { type: 'chat_group', chatGroupId: 'same' }, query: '日程' });

    expect(memory.restoreQuery({ context: { type: 'global' } })).toBe('global');
    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'same' } })).toBe('  予約  ');
    expect(memory.restoreQuery({ context: { type: 'chat_group', chatGroupId: 'same' } })).toBe('日程');
    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'new' } })).toBe('');
  });

  it('uses one LRU limit for chats and chat groups, refreshing restored entries', () => {
    const memory = createSearchQueryMemory({ targetLimit: 2 });
    memory.rememberQuery({ context: { type: 'global' }, query: 'global' });
    memory.rememberQuery({ context: { type: 'chat', chatId: 'a' }, query: 'A' });
    memory.rememberQuery({ context: { type: 'chat_group', chatGroupId: 'b' }, query: 'B' });
    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'a' } })).toBe('A');
    memory.rememberQuery({ context: { type: 'chat', chatId: 'c' }, query: 'C' });

    expect(memory.restoreQuery({ context: { type: 'chat_group', chatGroupId: 'b' } })).toBe('');
    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'a' } })).toBe('A');
    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'c' } })).toBe('C');
    expect(memory.restoreQuery({ context: { type: 'global' } })).toBe('global');
  });

  it('refreshes edited entries without consuming another slot', () => {
    const memory = createSearchQueryMemory({ targetLimit: 2 });
    memory.rememberQuery({ context: { type: 'chat', chatId: 'a' }, query: 'A' });
    memory.rememberQuery({ context: { type: 'chat', chatId: 'b' }, query: 'B' });
    memory.rememberQuery({ context: { type: 'chat', chatId: 'a' }, query: 'edited A' });
    memory.rememberQuery({ context: { type: 'chat_group', chatGroupId: 'c' }, query: 'C' });

    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'b' } })).toBe('');
    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'a' } })).toBe('edited A');
    expect(memory.restoreQuery({ context: { type: 'chat_group', chatGroupId: 'c' } })).toBe('C');
  });

  it('clears erased queries and does not reserve slots for empty targets', () => {
    const memory = createSearchQueryMemory({ targetLimit: 1 });
    memory.rememberQuery({ context: { type: 'chat', chatId: 'a' }, query: 'A' });
    expect(memory.restoreQuery({ context: { type: 'chat_group', chatGroupId: 'empty' } })).toBe('');
    memory.rememberQuery({ context: { type: 'chat_group', chatGroupId: 'empty' }, query: '' });
    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'a' } })).toBe('A');
    memory.rememberQuery({ context: { type: 'chat', chatId: 'a' }, query: '' });
    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'a' } })).toBe('');
    memory.rememberQuery({ context: { type: 'global' }, query: 'global' });
    memory.rememberQuery({ context: { type: 'global' }, query: '' });
    expect(memory.restoreQuery({ context: { type: 'global' } })).toBe('');
  });

  it('keeps the global query when target retention is disabled', () => {
    const memory = createSearchQueryMemory({ targetLimit: 0 });
    memory.rememberQuery({ context: { type: 'global' }, query: 'global' });
    memory.rememberQuery({ context: { type: 'chat', chatId: 'a' }, query: 'A' });
    expect(memory.restoreQuery({ context: { type: 'global' } })).toBe('global');
    expect(memory.restoreQuery({ context: { type: 'chat', chatId: 'a' } })).toBe('');
  });

  it.each([-1, 1.5, NaN, Infinity])('rejects an invalid target limit %s', targetLimit => {
    expect(() => createSearchQueryMemory({ targetLimit })).toThrow('non-negative integer');
  });
});
