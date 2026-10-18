import { describe, expect, it } from 'vitest';
import { formatSearchUpdated } from './search-updated';

const now = Date.parse('2026-10-17T12:00:00.000Z');

describe('model search update dates', () => {
  it('uses relative days for recent updates and preserves an exact datetime and tooltip', () => {
    const value = formatSearchUpdated({ lastModified: '2026-10-14T12:00:00.000Z', now, locale: 'en' });
    expect(value?.label).toBe('3 days ago');
    expect(value?.datetime).toBe('2026-10-14T12:00:00.000Z');
    expect(value?.title).toContain('2026');
    expect(formatSearchUpdated({ lastModified: '2026-10-11T12:00:00.000Z', now, locale: 'en' })?.label).toBe('6 days ago');
  });

  it('switches at seven elapsed days to a month and day without a time', () => {
    expect(formatSearchUpdated({ lastModified: '2026-10-10T12:00:00.000Z', now, locale: 'en' })?.label).toBe('Oct 10');
    expect(formatSearchUpdated({ lastModified: '2026-08-20T12:00:00.000Z', now, locale: 'en' })?.label).toBe('Aug 20');
  });

  it('adds the year when the update is in a different year and uses an absolute date for future updates', () => {
    expect(formatSearchUpdated({ lastModified: '2025-08-20T12:00:00.000Z', now, locale: 'en' })?.label).toBe('Aug 20, 2025');
    expect(formatSearchUpdated({ lastModified: '2026-11-20T12:00:00.000Z', now, locale: 'en' })?.label).toBe('Nov 20');
  });

  it('uses the UI locale for relative and absolute dates', () => {
    expect(formatSearchUpdated({ lastModified: '2026-10-14T12:00:00.000Z', now, locale: 'ja' })?.label).toMatch(/^3\s*日前$/u);
    expect(formatSearchUpdated({ lastModified: '2026-08-20T12:00:00.000Z', now, locale: 'ja' })?.label).toBe('8月20日');
  });

  it('omits invalid input without requiring a clock or timer', () => {
    expect(formatSearchUpdated({ lastModified: 'not a date', now, locale: 'en' })).toBeUndefined();
    expect(formatSearchUpdated({ lastModified: '2026-08-20T12:00:00.000Z', now: Number.NaN, locale: 'en' })).toBeUndefined();
  });
});
