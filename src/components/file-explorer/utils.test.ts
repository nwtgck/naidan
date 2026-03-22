import { describe, it, expect } from 'vitest';
import { getFileExtension, getMimeCategory, formatSize, formatDate, sortEntries, filterEntries } from './utils';
import type { FileExplorerEntry, SortConfig } from './types';

// ---- helpers ----

function makeEntry(overrides: Partial<FileExplorerEntry> & { name: string }): FileExplorerEntry {
  return {
    kind: 'file',
    handle: {} as FileSystemHandle,
    size: undefined,
    lastModified: undefined,
    extension: '',
    mimeCategory: 'binary',
    ...overrides,
  };
}

// ---- getFileExtension ----

describe('getFileExtension', () => {
  it('returns lowercase extension including dot', () => {
    expect(getFileExtension({ name: 'README.MD' })).toBe('.md');
  });

  it('returns empty string for no extension', () => {
    expect(getFileExtension({ name: 'Makefile' })).toBe('');
  });

  it('returns empty string when dot is first character', () => {
    expect(getFileExtension({ name: '.gitignore' })).toBe('');
  });

  it('handles multiple dots — returns last extension', () => {
    expect(getFileExtension({ name: 'archive.tar.gz' })).toBe('.gz');
  });

  it('handles file with only dots', () => {
    expect(getFileExtension({ name: '...' })).toBe('.');
  });
});

// ---- getMimeCategory ----

describe('getMimeCategory', () => {
  it('returns text for .txt', () => {
    expect(getMimeCategory({ extension: '.txt' })).toBe('text');
  });

  it('returns image for .png', () => {
    expect(getMimeCategory({ extension: '.png' })).toBe('image');
  });

  it('returns video for .mp4', () => {
    expect(getMimeCategory({ extension: '.mp4' })).toBe('video');
  });

  it('returns audio for .mp3', () => {
    expect(getMimeCategory({ extension: '.mp3' })).toBe('audio');
  });

  it('returns binary for unknown extension', () => {
    expect(getMimeCategory({ extension: '.xyz' })).toBe('binary');
  });

  it('returns binary for empty extension', () => {
    expect(getMimeCategory({ extension: '' })).toBe('binary');
  });
});

// ---- formatSize ----

describe('formatSize', () => {
  it('returns dash for undefined', () => {
    expect(formatSize({ bytes: undefined })).toBe('—');
  });

  it('returns "0 B" for 0', () => {
    expect(formatSize({ bytes: 0 })).toBe('0 B');
  });

  it('returns bytes for small values', () => {
    expect(formatSize({ bytes: 512 })).toBe('512 B');
  });

  it('returns KB for kilobyte range', () => {
    expect(formatSize({ bytes: 1024 })).toBe('1.0 KB');
  });

  it('returns MB for megabyte range', () => {
    expect(formatSize({ bytes: 1024 * 1024 })).toBe('1.0 MB');
  });

  it('returns GB for gigabyte range', () => {
    expect(formatSize({ bytes: 1024 * 1024 * 1024 })).toBe('1.00 GB');
  });

  it('rounds KB to one decimal', () => {
    expect(formatSize({ bytes: 1536 })).toBe('1.5 KB');
  });
});

// ---- formatDate ----

describe('formatDate', () => {
  it('returns dash for undefined', () => {
    expect(formatDate({ timestamp: undefined })).toBe('—');
  });

  it('returns a non-empty string for a valid timestamp', () => {
    const result = formatDate({ timestamp: new Date('2024-01-15T12:00:00').getTime() });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---- sortEntries ----

describe('sortEntries', () => {
  const dir = (name: string): FileExplorerEntry =>
    makeEntry({ name, kind: 'directory', extension: '', mimeCategory: 'binary' });

  const file = (name: string, size?: number, lastModified?: number, ext = ''): FileExplorerEntry =>
    makeEntry({ name, kind: 'file', size, lastModified, extension: ext });

  const ascName: SortConfig = { field: 'name', direction: 'ascending' };
  const descName: SortConfig = { field: 'name', direction: 'descending' };
  const ascSize: SortConfig = { field: 'size', direction: 'ascending' };
  const ascDate: SortConfig = { field: 'dateModified', direction: 'ascending' };
  const ascType: SortConfig = { field: 'type', direction: 'ascending' };

  it('directories always come before files', () => {
    const entries = [file('a.txt'), dir('z'), file('b.txt'), dir('a')];
    const sorted = sortEntries({ entries, config: ascName });
    expect(sorted[0]!.kind).toBe('directory');
    expect(sorted[1]!.kind).toBe('directory');
    expect(sorted[2]!.kind).toBe('file');
    expect(sorted[3]!.kind).toBe('file');
  });

  it('sorts by name ascending', () => {
    const entries = [file('c.txt'), file('a.txt'), file('b.txt')];
    const sorted = sortEntries({ entries, config: ascName });
    expect(sorted.map(e => e.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('sorts by name descending', () => {
    const entries = [file('a.txt'), file('c.txt'), file('b.txt')];
    const sorted = sortEntries({ entries, config: descName });
    expect(sorted.map(e => e.name)).toEqual(['c.txt', 'b.txt', 'a.txt']);
  });

  it('sorts by size ascending (undefined treated as -1)', () => {
    const entries = [file('b.txt', 200), file('a.txt', 100), file('c.txt', undefined)];
    const sorted = sortEntries({ entries, config: ascSize });
    expect(sorted[0]!.name).toBe('c.txt'); // undefined → -1
    expect(sorted[1]!.name).toBe('a.txt');
    expect(sorted[2]!.name).toBe('b.txt');
  });

  it('sorts by dateModified ascending', () => {
    const entries = [file('b.txt', 0, 2000), file('a.txt', 0, 1000), file('c.txt', 0, 3000)];
    const sorted = sortEntries({ entries, config: ascDate });
    expect(sorted.map(e => e.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('sorts by type (extension) ascending, then name as tiebreaker', () => {
    const entries = [
      file('b.png', 0, 0, '.png'),
      file('a.txt', 0, 0, '.txt'),
      file('a.png', 0, 0, '.png'),
    ];
    const sorted = sortEntries({ entries, config: ascType });
    expect(sorted[0]!.name).toBe('a.png');
    expect(sorted[1]!.name).toBe('b.png');
    expect(sorted[2]!.name).toBe('a.txt');
  });

  it('does not mutate the original array', () => {
    const entries = [file('b.txt'), file('a.txt')];
    const original = [...entries];
    sortEntries({ entries, config: ascName });
    expect(entries).toEqual(original);
  });

  it('numeric sort for names with numbers', () => {
    const entries = [file('item10.txt'), file('item2.txt'), file('item1.txt')];
    const sorted = sortEntries({ entries, config: ascName });
    expect(sorted.map(e => e.name)).toEqual(['item1.txt', 'item2.txt', 'item10.txt']);
  });
});

// ---- filterEntries ----

describe('filterEntries', () => {
  const entries: FileExplorerEntry[] = [
    makeEntry({ name: 'README.md' }),
    makeEntry({ name: 'package.json' }),
    makeEntry({ name: 'src' }),
  ];

  it('returns all entries for empty query', () => {
    expect(filterEntries({ entries, query: '' })).toEqual(entries);
  });

  it('returns all entries for whitespace-only query', () => {
    expect(filterEntries({ entries, query: '   ' })).toEqual(entries);
  });

  it('filters case-insensitively', () => {
    const result = filterEntries({ entries, query: 'readme' });
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('README.md');
  });

  it('returns multiple matches', () => {
    const result = filterEntries({ entries, query: 'e' });
    // README.md, package.json
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array when no match', () => {
    expect(filterEntries({ entries, query: 'zzznomatch' })).toHaveLength(0);
  });
});
