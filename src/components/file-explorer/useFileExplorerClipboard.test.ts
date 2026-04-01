import { describe, it, expect } from 'vitest';
import { useFileExplorerClipboard } from './useFileExplorerClipboard';
import type { FileExplorerEntry } from './types';
import type { ExplorerDirectory } from './explorer-directory';

function makeEntry(name: string): FileExplorerEntry {
  return {
    name,
    kind: 'file',
    handle: {} as FileSystemHandle,
    directory: undefined,
    size: undefined,
    lastModified: undefined,
    extension: '.txt',
    mimeCategory: 'text',
    readOnly: false,
  };
}

const fakeDir = {} as ExplorerDirectory;

describe('useFileExplorerClipboard', () => {
  it('starts empty', () => {
    const { clipboardState, hasClipboardContent } = useFileExplorerClipboard();
    expect(clipboardState.value.operation).toBeUndefined();
    expect(clipboardState.value.entries).toHaveLength(0);
    expect(hasClipboardContent.value).toBe(false);
  });

  it('clipboardCopy sets copy operation with entries', () => {
    const { clipboardState, hasClipboardContent, clipboardCopy } = useFileExplorerClipboard();
    const entries = [makeEntry('a.txt'), makeEntry('b.txt')];
    clipboardCopy({ entries, sourceDirectory: fakeDir });
    expect(clipboardState.value.operation).toBe('copy');
    expect(clipboardState.value.entries).toHaveLength(2);
    expect(clipboardState.value.sourceDirectory).toStrictEqual(fakeDir);
    expect(hasClipboardContent.value).toBe(true);
  });

  it('clipboardCut sets cut operation with entries', () => {
    const { clipboardState, hasClipboardContent, clipboardCut } = useFileExplorerClipboard();
    const entries = [makeEntry('c.txt')];
    clipboardCut({ entries, sourceDirectory: fakeDir });
    expect(clipboardState.value.operation).toBe('cut');
    expect(clipboardState.value.entries).toHaveLength(1);
    expect(hasClipboardContent.value).toBe(true);
  });

  it('clipboardCopy snapshots entries (does not share reference)', () => {
    const { clipboardState, clipboardCopy } = useFileExplorerClipboard();
    const entries = [makeEntry('x.txt')];
    clipboardCopy({ entries, sourceDirectory: fakeDir });
    entries.push(makeEntry('y.txt'));
    expect(clipboardState.value.entries).toHaveLength(1);
  });

  it('clipboardCut snapshots entries (does not share reference)', () => {
    const { clipboardState, clipboardCut } = useFileExplorerClipboard();
    const entries = [makeEntry('x.txt')];
    clipboardCut({ entries, sourceDirectory: fakeDir });
    entries.push(makeEntry('y.txt'));
    expect(clipboardState.value.entries).toHaveLength(1);
  });

  it('clearClipboard resets state', () => {
    const { clipboardState, hasClipboardContent, clipboardCopy, clearClipboard } = useFileExplorerClipboard();
    clipboardCopy({ entries: [makeEntry('a.txt')], sourceDirectory: fakeDir });
    clearClipboard();
    expect(clipboardState.value.operation).toBeUndefined();
    expect(clipboardState.value.entries).toHaveLength(0);
    expect(clipboardState.value.sourceDirectory).toBeUndefined();
    expect(hasClipboardContent.value).toBe(false);
  });

  it('isCut returns true for cut entries', () => {
    const { isCut, clipboardCut } = useFileExplorerClipboard();
    const entry = makeEntry('file.txt');
    clipboardCut({ entries: [entry], sourceDirectory: fakeDir });
    expect(isCut({ entry })).toBe(true);
  });

  it('isCut returns false for copy entries', () => {
    const { isCut, clipboardCopy } = useFileExplorerClipboard();
    const entry = makeEntry('file.txt');
    clipboardCopy({ entries: [entry], sourceDirectory: fakeDir });
    expect(isCut({ entry })).toBe(false);
  });

  it('isCut returns false for entry not in clipboard', () => {
    const { isCut, clipboardCut } = useFileExplorerClipboard();
    clipboardCut({ entries: [makeEntry('a.txt')], sourceDirectory: fakeDir });
    expect(isCut({ entry: makeEntry('b.txt') })).toBe(false);
  });

  it('isCut returns false when clipboard is empty', () => {
    const { isCut } = useFileExplorerClipboard();
    expect(isCut({ entry: makeEntry('file.txt') })).toBe(false);
  });

  it('overwriting cut with copy clears cut state', () => {
    const { clipboardState, clipboardCut, clipboardCopy } = useFileExplorerClipboard();
    clipboardCut({ entries: [makeEntry('a.txt')], sourceDirectory: fakeDir });
    clipboardCopy({ entries: [makeEntry('b.txt')], sourceDirectory: fakeDir });
    expect(clipboardState.value.operation).toBe('copy');
    expect(clipboardState.value.entries[0]!.name).toBe('b.txt');
  });

  it('hasClipboardContent is false when entries array is empty', () => {
    const { hasClipboardContent, clipboardCopy } = useFileExplorerClipboard();
    clipboardCopy({ entries: [], sourceDirectory: fakeDir });
    expect(hasClipboardContent.value).toBe(false);
  });
});
