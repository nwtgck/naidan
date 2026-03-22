import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileExplorerPreview } from './useFileExplorerPreview';
import type { FileExplorerEntry, MimeCategory } from './types';
import { TEXT_PREVIEW_SIZE_LIMIT, MEDIA_PREVIEW_SIZE_LIMIT } from './constants';

// Mock highlight.js to avoid dynamic import failures in test environment
vi.mock('highlight.js/lib/core', () => ({
  default: {
    registerLanguage: vi.fn(),
    highlight: vi.fn().mockReturnValue({ value: '<span>highlighted</span>' }),
    highlightAuto: vi.fn().mockReturnValue({ value: '<span>auto</span>' }),
  },
}));

// Mock dynamic language imports
vi.mock('highlight.js/lib/languages/typescript', () => ({ default: vi.fn() }));
vi.mock('highlight.js/lib/languages/json', () => ({ default: vi.fn() }));

// --- Helpers ---

function makeEntry(overrides: Partial<FileExplorerEntry> & { name: string }): FileExplorerEntry {
  return {
    kind: 'file',
    handle: {} as FileSystemHandle,
    size: 100,
    lastModified: Date.now(),
    extension: '',
    mimeCategory: 'binary',
    ...overrides,
  };
}

/** Returns a fake file-like object — avoids File.size non-configurable property issues */
function makeFakeFile(content: string, sizeOverride?: number) {
  const buf = new TextEncoder().encode(content);
  return {
    size: sizeOverride ?? buf.byteLength,
    name: 'test.txt',
    type: 'text/plain',
    text: vi.fn().mockResolvedValue(content),
    arrayBuffer: vi.fn().mockResolvedValue(buf.buffer),
  };
}

function makeFileHandle(content: string, sizeOverride?: number): FileSystemFileHandle {
  return {
    kind: 'file' as const,
    name: 'test.txt',
    getFile: vi.fn().mockResolvedValue(makeFakeFile(content, sizeOverride)),
    createWritable: vi.fn(),
  } as unknown as FileSystemFileHandle;
}

function makeMediaFileHandle(name: string, sizeOverride?: number): FileSystemFileHandle {
  return {
    kind: 'file' as const,
    name,
    getFile: vi.fn().mockResolvedValue({ size: sizeOverride ?? 1000, name, type: 'application/octet-stream' }),
    createWritable: vi.fn(),
  } as unknown as FileSystemFileHandle;
}

// Spy on URL.createObjectURL / revokeObjectURL
const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);

// --- Tests ---

describe('useFileExplorerPreview', () => {
  beforeEach(() => {
    createObjectURLSpy.mockClear();
    revokeObjectURLSpy.mockClear();
  });

  // ---- initial state ----

  it('starts in idle loading state with no entry', () => {
    const { previewState } = useFileExplorerPreview();
    expect(previewState.value.loadingState).toBe('idle');
    expect(previewState.value.entry).toBeUndefined();
    expect(previewState.value.visibility).toBe('visible');
  });

  // ---- togglePreviewVisibility ----

  it('togglePreviewVisibility toggles between visible and hidden', () => {
    const { previewState, togglePreviewVisibility } = useFileExplorerPreview();
    expect(previewState.value.visibility).toBe('visible');
    togglePreviewVisibility();
    expect(previewState.value.visibility).toBe('hidden');
    togglePreviewVisibility();
    expect(previewState.value.visibility).toBe('visible');
  });

  // ---- clearPreview ----

  it('clearPreview resets state to idle', async () => {
    const { previewState, loadPreview, clearPreview } = useFileExplorerPreview();
    const fh = makeFileHandle('hello');
    const entry = makeEntry({ name: 'hello.txt', extension: '.txt', mimeCategory: 'text', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    clearPreview();
    expect(previewState.value.loadingState).toBe('idle');
    expect(previewState.value.entry).toBeUndefined();
    expect(previewState.value.textContent).toBeUndefined();
  });

  it('clearPreview revokes any existing objectUrl', async () => {
    const { loadPreview, clearPreview } = useFileExplorerPreview();
    const fh = makeMediaFileHandle('photo.png');
    const entry = makeEntry({ name: 'photo.png', extension: '.png', mimeCategory: 'image', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    clearPreview();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:fake-url');
  });

  // ---- loadPreview — directory ----

  it('loadPreview for a directory sets entry and loaded state without loading content', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview();
    const entry = makeEntry({ name: 'subdir', kind: 'directory', mimeCategory: 'binary' });
    await loadPreview({ entry });
    expect(previewState.value.loadingState).toBe('loaded');
    expect(previewState.value.entry).toEqual(entry);
    expect(previewState.value.textContent).toBeUndefined();
    expect(previewState.value.objectUrl).toBeUndefined();
  });

  // ---- loadPreview — text ----

  it('loadPreview for a text file sets textContent and loaded state', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview();
    const fh = makeFileHandle('hello world');
    const entry = makeEntry({ name: 'hello.txt', extension: '.txt', mimeCategory: 'text', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    expect(previewState.value.loadingState).toBe('loaded');
    expect(previewState.value.textContent).toBe('hello world');
    expect(previewState.value.entry).toEqual(entry);
  });

  it('loadPreview for a text file produces highlightedHtml via hljs', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview();
    const fh = makeFileHandle('const x = 1;');
    const entry = makeEntry({ name: 'index.ts', extension: '.ts', mimeCategory: 'text', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    expect(previewState.value.highlightedHtml).toBeDefined();
  });

  it('loadPreview for text marks oversized when file exceeds TEXT_PREVIEW_SIZE_LIMIT', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview();
    const fh = makeFileHandle('x', TEXT_PREVIEW_SIZE_LIMIT + 1);
    const entry = makeEntry({ name: 'big.txt', extension: '.txt', mimeCategory: 'text', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    expect(previewState.value.oversized).toBe(true);
    expect(previewState.value.loadingState).toBe('loaded');
    expect(previewState.value.textContent).toBeUndefined();
  });

  // ---- loadPreview — JSON formatting ----

  it('loadPreview formats JSON content by default', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview();
    const fh = makeFileHandle('{"a":1,"b":2}');
    const entry = makeEntry({ name: 'data.json', extension: '.json', mimeCategory: 'text', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    // textContent should be the original raw text
    expect(previewState.value.textContent).toBe('{"a":1,"b":2}');
    expect(previewState.value.jsonFormatMode).toBe('formatted');
  });

  // ---- loadPreview — image/video/audio ----

  it.each<[MimeCategory, string]>([
    ['image', 'photo.png'],
    ['video', 'clip.mp4'],
    ['audio', 'song.mp3'],
  ])('loadPreview for %s creates an objectUrl', async (mimeCategory, name) => {
    const { previewState, loadPreview } = useFileExplorerPreview();
    const fh = makeMediaFileHandle(name);
    const ext = '.' + name.split('.').pop()!;
    const entry = makeEntry({ name, extension: ext, mimeCategory, handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    expect(previewState.value.objectUrl).toBe('blob:fake-url');
    expect(previewState.value.loadingState).toBe('loaded');
  });

  it('loadPreview for media marks oversized when file exceeds MEDIA_PREVIEW_SIZE_LIMIT', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview();
    const fh = makeMediaFileHandle('huge.mp4', MEDIA_PREVIEW_SIZE_LIMIT + 1);
    const entry = makeEntry({ name: 'huge.mp4', extension: '.mp4', mimeCategory: 'video', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    expect(previewState.value.oversized).toBe(true);
    expect(previewState.value.objectUrl).toBeUndefined();
  });

  it('loadPreview revokes previous objectUrl before loading new media', async () => {
    const { loadPreview } = useFileExplorerPreview();
    const fh1 = makeMediaFileHandle('a.png');
    const fh2 = makeMediaFileHandle('b.png');
    const e1 = makeEntry({ name: 'a.png', extension: '.png', mimeCategory: 'image', handle: fh1 as FileSystemHandle });
    const e2 = makeEntry({ name: 'b.png', extension: '.png', mimeCategory: 'image', handle: fh2 as FileSystemHandle });
    await loadPreview({ entry: e1 });
    await loadPreview({ entry: e2 });
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:fake-url');
  });

  // ---- loadPreview — binary ----

  it('loadPreview for binary sets loaded state without content or objectUrl', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview();
    const fh = makeMediaFileHandle('data.bin');
    const entry = makeEntry({ name: 'data.bin', extension: '.bin', mimeCategory: 'binary', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    expect(previewState.value.loadingState).toBe('loaded');
    expect(previewState.value.textContent).toBeUndefined();
    expect(previewState.value.objectUrl).toBeUndefined();
  });

  // ---- loadPreview — error ----

  it('loadPreview sets error state when getFile throws', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview();
    const fh = {
      kind: 'file' as const,
      name: 'broken.txt',
      getFile: vi.fn().mockRejectedValue(new Error('permission denied')),
      createWritable: vi.fn(),
    } as unknown as FileSystemFileHandle;
    const entry = makeEntry({ name: 'broken.txt', extension: '.txt', mimeCategory: 'text', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    expect(previewState.value.loadingState).toBe('error');
    expect(previewState.value.errorMessage).toContain('permission denied');
  });

  // ---- loadPreviewForced ----

  it('loadPreviewForced bypasses oversized guard for text files', async () => {
    const { previewState, loadPreviewForced } = useFileExplorerPreview();
    const fh = makeFileHandle('big content', TEXT_PREVIEW_SIZE_LIMIT + 1);
    const entry = makeEntry({ name: 'big.txt', extension: '.txt', mimeCategory: 'text', handle: fh as FileSystemHandle });
    await loadPreviewForced({ entry });
    expect(previewState.value.oversized).toBe(false);
    expect(previewState.value.textContent).toBe('big content');
  });

  it('loadPreviewForced is no-op for directories', async () => {
    const { previewState, loadPreviewForced } = useFileExplorerPreview();
    const entry = makeEntry({ name: 'subdir', kind: 'directory', mimeCategory: 'binary' });
    await loadPreviewForced({ entry });
    expect(previewState.value.loadingState).toBe('idle');
  });

  // ---- toggleJsonFormat ----

  it('toggleJsonFormat switches between raw and formatted', async () => {
    const { previewState, loadPreview, toggleJsonFormat } = useFileExplorerPreview();
    const fh = makeFileHandle('{"a":1}');
    const entry = makeEntry({ name: 'data.json', extension: '.json', mimeCategory: 'text', handle: fh as FileSystemHandle });
    await loadPreview({ entry });

    expect(previewState.value.jsonFormatMode).toBe('formatted');
    toggleJsonFormat();
    expect(previewState.value.jsonFormatMode).toBe('raw');
    toggleJsonFormat();
    expect(previewState.value.jsonFormatMode).toBe('formatted');
  });

  it('toggleJsonFormat is no-op when no entry is loaded', () => {
    const { previewState, toggleJsonFormat } = useFileExplorerPreview();
    toggleJsonFormat();
    expect(previewState.value.jsonFormatMode).toBe('formatted');
  });

  it('toggleJsonFormat is no-op for non-JSON files', async () => {
    const { previewState, loadPreview, toggleJsonFormat } = useFileExplorerPreview();
    const fh = makeFileHandle('hello');
    const entry = makeEntry({ name: 'hello.txt', extension: '.txt', mimeCategory: 'text', handle: fh as FileSystemHandle });
    await loadPreview({ entry });
    const modeBefore = previewState.value.jsonFormatMode;
    toggleJsonFormat();
    expect(previewState.value.jsonFormatMode).toBe(modeBefore);
  });
});
