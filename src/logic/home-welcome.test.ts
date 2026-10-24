import { afterEach, describe, expect, it, vi } from 'vitest';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import { homeDateCategory, nextHomeDateChange, selectHomeRecentItems } from './home-welcome';

afterEach(() => vi.unstubAllEnvs());

describe('home recent items', () => {
  it('keeps the three newest summaries without changing the sidebar collection', () => {
    const items = Object.freeze([1, 5, 2, 4, 3].map(updatedAt => Object.freeze({ id: toChatId({ raw: String(updatedAt) }), updatedAt })));
    expect(selectHomeRecentItems({ items })).toEqual([items[1], items[3], items[4]]);
    expect(items.map(item => item.updatedAt)).toEqual([1, 5, 2, 4, 3]);
  });

  it('uses IDs to keep tied timestamps deterministic across sidebar order and locale', () => {
    const items = ['d', 'b', 'c', 'a'].map(raw => ({ id: toChatId({ raw }), updatedAt: 10 }));
    expect(selectHomeRecentItems({ items }).map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(selectHomeRecentItems({ items: [...items].reverse() }).map(item => item.id)).toEqual(['a', 'b', 'c']);
  });

  it.each([0, 1, 2])('does not pad a list containing %i items', count => {
    const items = Array.from({ length: count }, (_, index) => ({ id: toChatGroupId({ raw: String(index) }), updatedAt: index }));
    expect(selectHomeRecentItems({ items })).toHaveLength(count);
  });
});

describe('home calendar dates', () => {
  it('distinguishes yesterday, today and tomorrow by local calendar date', () => {
    const now = new Date(2026, 9, 24, 12).getTime();
    expect(homeDateCategory({ now, timestamp: new Date(2026, 9, 24, 0).getTime() })).toBe('today');
    expect(homeDateCategory({ now, timestamp: new Date(2026, 9, 23, 23, 59).getTime() })).toBe('yesterday');
    expect(homeDateCategory({ now, timestamp: new Date(2026, 9, 22, 23, 59).getTime() })).toBe('date');
    expect(homeDateCategory({ now, timestamp: new Date(2026, 9, 25, 0).getTime() })).toBe('date');
    expect(nextHomeDateChange({ now })).toBe(new Date(2026, 9, 25).getTime());
  });

  it('handles a 23-hour day without including the preceding evening in yesterday', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const now = new Date(2026, 2, 9, 12).getTime();
    expect(homeDateCategory({ now, timestamp: new Date(2026, 2, 8, 0, 30).getTime() })).toBe('yesterday');
    expect(homeDateCategory({ now, timestamp: new Date(2026, 2, 7, 23, 30).getTime() })).toBe('date');
    const start = new Date(2026, 2, 8).getTime();
    expect(nextHomeDateChange({ now: start }) - start).toBe(23 * 60 * 60 * 1000);
  });

  it('includes the whole previous calendar day when it lasted 25 hours', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const now = new Date(2026, 10, 2, 12).getTime();
    expect(homeDateCategory({ now, timestamp: new Date(2026, 10, 1, 0, 30).getTime() })).toBe('yesterday');
    const start = new Date(2026, 10, 1).getTime();
    expect(nextHomeDateChange({ now: start }) - start).toBe(25 * 60 * 60 * 1000);
  });
});
