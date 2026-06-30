import { describe, it, expect } from 'vitest';
import { useFileExplorerClipboard } from './useFileExplorerClipboard';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';

function makeEntry(name: string): FileExplorerEntry {
  return {
    path: `/${name}`,
    name,
    kind: 'file',
    size: undefined,
    lastModified: undefined,
    extension: '.txt',
    mimeCategory: 'text',
    readOnly: false,
    canNavigate: false,
    canMutate: true,
  };
}

const fakeDir = '/workspace';

describe('useFileExplorerClipboard', () => {
  it('starts empty', () => {
    const { clipboardState, TEST_ONLY: { hasClipboardContent } } = useFileExplorerClipboard();
    expect(clipboardState.value.operation).toBeUndefined();
    expect(clipboardState.value.entries).toHaveLength(0);
    expect(hasClipboardContent.value).toBe(false);
  });

  it('clipboardCopy sets copy operation with entries', () => {
    const { clipboardState, clipboardCopy, TEST_ONLY: { hasClipboardContent } } = useFileExplorerClipboard();
    const entries = [makeEntry('a.txt'), makeEntry('b.txt')];
    clipboardCopy({ entries, sourceDirectoryPath: fakeDir });
    expect(clipboardState.value.operation).toBe('copy');
    expect(clipboardState.value.entries).toHaveLength(2);
    expect(clipboardState.value.sourceDirectory).toStrictEqual(fakeDir);
    expect(hasClipboardContent.value).toBe(true);
  });

  it('clipboardCut sets cut operation with entries', () => {
    const { clipboardState, clipboardCut, TEST_ONLY: { hasClipboardContent } } = useFileExplorerClipboard();
    const entries = [makeEntry('c.txt')];
    clipboardCut({ entries, sourceDirectoryPath: fakeDir });
    expect(clipboardState.value.operation).toBe('cut');
    expect(clipboardState.value.entries).toHaveLength(1);
    expect(hasClipboardContent.value).toBe(true);
  });

  it('clipboardCopy snapshots entries (does not share reference)', () => {
    const { clipboardState, clipboardCopy } = useFileExplorerClipboard();
    const entries = [makeEntry('x.txt')];
    clipboardCopy({ entries, sourceDirectoryPath: fakeDir });
    entries.push(makeEntry('y.txt'));
    expect(clipboardState.value.entries).toHaveLength(1);
  });

  it('clipboardCut snapshots entries (does not share reference)', () => {
    const { clipboardState, clipboardCut } = useFileExplorerClipboard();
    const entries = [makeEntry('x.txt')];
    clipboardCut({ entries, sourceDirectoryPath: fakeDir });
    entries.push(makeEntry('y.txt'));
    expect(clipboardState.value.entries).toHaveLength(1);
  });

  it('clearClipboard resets state', () => {
    const { clipboardState, clipboardCopy, clearClipboard, TEST_ONLY: { hasClipboardContent } } = useFileExplorerClipboard();
    clipboardCopy({ entries: [makeEntry('a.txt')], sourceDirectoryPath: fakeDir });
    clearClipboard();
    expect(clipboardState.value.operation).toBeUndefined();
    expect(clipboardState.value.entries).toHaveLength(0);
    expect(clipboardState.value.sourceDirectory).toBeUndefined();
    expect(hasClipboardContent.value).toBe(false);
  });

  it('isCut returns true for cut entries', () => {
    const { clipboardCut, TEST_ONLY: { isCut } } = useFileExplorerClipboard();
    const entry = makeEntry('file.txt');
    clipboardCut({ entries: [entry], sourceDirectoryPath: fakeDir });
    expect(isCut({ entry })).toBe(true);
  });

  it('isCut returns false for copy entries', () => {
    const { clipboardCopy, TEST_ONLY: { isCut } } = useFileExplorerClipboard();
    const entry = makeEntry('file.txt');
    clipboardCopy({ entries: [entry], sourceDirectoryPath: fakeDir });
    expect(isCut({ entry })).toBe(false);
  });

  it('isCut returns false for entry not in clipboard', () => {
    const { clipboardCut, TEST_ONLY: { isCut } } = useFileExplorerClipboard();
    clipboardCut({ entries: [makeEntry('a.txt')], sourceDirectoryPath: fakeDir });
    expect(isCut({ entry: makeEntry('b.txt') })).toBe(false);
  });

  it('isCut returns false when clipboard is empty', () => {
    const { TEST_ONLY: { isCut } } = useFileExplorerClipboard();
    expect(isCut({ entry: makeEntry('file.txt') })).toBe(false);
  });

  it('overwriting cut with copy clears cut state', () => {
    const { clipboardState, clipboardCut, clipboardCopy } = useFileExplorerClipboard();
    clipboardCut({ entries: [makeEntry('a.txt')], sourceDirectoryPath: fakeDir });
    clipboardCopy({ entries: [makeEntry('b.txt')], sourceDirectoryPath: fakeDir });
    expect(clipboardState.value.operation).toBe('copy');
    expect(clipboardState.value.entries[0]!.name).toBe('b.txt');
  });

  it('hasClipboardContent is false when entries array is empty', () => {
    const { clipboardCopy, TEST_ONLY: { hasClipboardContent } } = useFileExplorerClipboard();
    clipboardCopy({ entries: [], sourceDirectoryPath: fakeDir });
    expect(hasClipboardContent.value).toBe(false);
  });
});
