import { describe, expect, it } from 'vitest';

import {
  addDirectoryDownloadExclusion,
  isDirectoryDownloadPathExcluded,
  normalizeDirectoryDownloadRelativePath,
} from './directory-download';

describe('directory download exclusions', () => {
  it('normalizes redundant path segments and rejects unsafe separators', () => {
    expect(normalizeDirectoryDownloadRelativePath({ path: './src/components/' })).toBe('src/components');
    expect(normalizeDirectoryDownloadRelativePath({ path: '../secret' })).toBeUndefined();
    expect(normalizeDirectoryDownloadRelativePath({ path: '/' })).toBeUndefined();
    expect(normalizeDirectoryDownloadRelativePath({ path: 'src\\components' })).toBeUndefined();
    expect(normalizeDirectoryDownloadRelativePath({ path: 'src/unsafe\0name' })).toBeUndefined();
  });

  it('matches a path when it or an ancestor is excluded', () => {
    const excludedRelativePaths = new Set(['dist/cache', 'debug.log']);
    expect(isDirectoryDownloadPathExcluded({ relativePath: 'dist/cache', excludedRelativePaths })).toBe(true);
    expect(isDirectoryDownloadPathExcluded({ relativePath: 'dist/cache/nested/data.bin', excludedRelativePaths })).toBe(true);
    expect(isDirectoryDownloadPathExcluded({ relativePath: 'dist/output.js', excludedRelativePaths })).toBe(false);
  });

  it('removes redundant descendants when a parent is added', () => {
    const result = addDirectoryDownloadExclusion({
      exclusions: [
        { relativePath: 'dist/cache', name: 'cache', kind: 'directory' },
        { relativePath: 'dist/output.js', name: 'output.js', kind: 'file' },
        { relativePath: 'src', name: 'src', kind: 'directory' },
      ],
      suggestion: { relativePath: 'dist', name: 'dist', kind: 'directory' },
    });
    expect(result).toEqual([
      { relativePath: 'src', name: 'src', kind: 'directory' },
      { relativePath: 'dist', name: 'dist', kind: 'directory' },
    ]);
  });

  it('does not add a descendant of an existing exclusion', () => {
    const exclusions = [{ relativePath: 'dist', name: 'dist', kind: 'directory' }] as const;
    expect(addDirectoryDownloadExclusion({
      exclusions,
      suggestion: { relativePath: 'dist/cache', name: 'cache', kind: 'directory' },
    })).toEqual(exclusions);
  });
});
