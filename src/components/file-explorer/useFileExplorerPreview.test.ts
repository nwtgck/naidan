import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileExplorerPreview } from './useFileExplorerPreview';
import type { FileExplorerEntry, MimeCategory } from './types';
import { TEXT_PREVIEW_SIZE_LIMIT, MEDIA_PREVIEW_SIZE_LIMIT } from './constants';
import type { FileExplorerWorkerClient } from '@/services/file-explorer/worker/types';
import type { FileExplorerReadPreviewResponse } from '@/services/file-explorer/worker/types';
import type { HighlightRequest } from '@/services/highlight/worker/types';

const highlightMock = vi.fn(async ({ request }: { request: HighlightRequest }) => ({
  html: request.language ? `<span>${request.language}</span>` : '<span>auto</span>',
  resolvedLanguage: request.language ?? 'plaintext',
}));

vi.mock('@/services/highlight/worker/client-shared', () => ({
  acquireSharedHighlightWorkerClient: vi.fn(async () => ({
    highlight: highlightMock,
    dispose: vi.fn(async () => undefined),
  })),
  releaseSharedHighlightWorkerClient: vi.fn(async () => undefined),
}));

function makeEntry(overrides: Partial<FileExplorerEntry> & { name: string }): FileExplorerEntry {
  return {
    path: `/${overrides.name}`,
    kind: 'file',
    size: 100,
    lastModified: Date.now(),
    extension: '',
    mimeCategory: 'binary',
    readOnly: false,
    canNavigate: false,
    canMutate: true,
    ...overrides,
  };
}

const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);

describe('useFileExplorerPreview', () => {
  let client: FileExplorerWorkerClient;

  beforeEach(() => {
    createObjectURLSpy.mockClear();
    revokeObjectURLSpy.mockClear();
    highlightMock.mockClear();
    client = {
      readDirectory: vi.fn(),
      readPreview: vi.fn(async ({ path, mode }: { path: string, mode: 'bounded' | 'force' }): Promise<FileExplorerReadPreviewResponse> => {
        switch (path) {
        case '/subdir':
          return { kind: 'directory' };
        case '/hello.txt':
          return { kind: 'text', rawText: 'hello world', displayText: 'hello world', languageHint: 'typescript', oversized: false };
        case '/index.ts':
          return { kind: 'text', rawText: 'const x = 1;', displayText: 'const x = 1;', languageHint: 'typescript', oversized: false };
        case '/big.txt':
          if (mode === 'bounded') {
            return { kind: 'text', rawText: '', displayText: '', languageHint: 'typescript', oversized: true };
          }
          return { kind: 'text', rawText: 'big content', displayText: 'big content', languageHint: 'typescript', oversized: false };
        case '/data.json':
          return { kind: 'text', rawText: '{"a":1,"b":2}', displayText: `\
{
  "a": 1,
  "b": 2
}`, languageHint: 'json', oversized: false };
        case '/photo.png':
        case '/clip.mp4':
        case '/song.mp3':
          return { kind: 'media', mediaKind: path.endsWith('.mp4') ? 'video' : path.endsWith('.mp3') ? 'audio' : 'image', blob: new Blob(['media']), mimeType: 'application/octet-stream', oversized: false };
        case '/huge.mp4':
          return { kind: 'media', mediaKind: 'video', blob: new Blob([]), mimeType: 'video/mp4', oversized: mode === 'bounded' };
        case '/data.bin':
          return { kind: 'binary', oversized: false };
        case '/broken.txt':
          throw new Error('permission denied');
        default:
          throw new Error(`Unexpected preview path: ${path}`);
        }
      }),
      readFile: vi.fn(),
      createFile: vi.fn(),
      createFolder: vi.fn(),
      deleteEntries: vi.fn(),
      renameEntry: vi.fn(),
      copyEntries: vi.fn(),
      moveEntries: vi.fn(),
      uploadFiles: vi.fn(),
      dispose: vi.fn(),
    };
  });

  it('starts in idle loading state with no entry', () => {
    const { previewState } = useFileExplorerPreview({ client });
    expect(previewState.value.loadingState).toBe('idle');
    expect(previewState.value.entry).toBeUndefined();
    expect(previewState.value.visibility).toBe('visible');
  });

  it('togglePreviewVisibility toggles between visible and hidden', () => {
    const { previewState, togglePreviewVisibility } = useFileExplorerPreview({ client });
    expect(previewState.value.visibility).toBe('visible');
    togglePreviewVisibility();
    expect(previewState.value.visibility).toBe('hidden');
    togglePreviewVisibility();
    expect(previewState.value.visibility).toBe('visible');
  });

  it('clearPreview resets state to idle', async () => {
    const { previewState, loadPreview, clearPreview } = useFileExplorerPreview({ client });
    await loadPreview({ entry: makeEntry({ name: 'hello.txt', extension: '.txt', mimeCategory: 'text' }) });
    clearPreview();
    expect(previewState.value.loadingState).toBe('idle');
    expect(previewState.value.entry).toBeUndefined();
    expect(previewState.value.textContent).toBeUndefined();
  });

  it('clearPreview revokes any existing objectUrl', async () => {
    const { loadPreview, clearPreview } = useFileExplorerPreview({ client });
    await loadPreview({ entry: makeEntry({ name: 'photo.png', extension: '.png', mimeCategory: 'image' }) });
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    clearPreview();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:fake-url');
  });

  it('loadPreview for a directory sets entry and loaded state without loading content', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview({ client });
    const entry = makeEntry({ name: 'subdir', path: '/subdir', kind: 'directory', mimeCategory: 'binary', canNavigate: true });
    await loadPreview({ entry });
    expect(previewState.value.loadingState).toBe('loaded');
    expect(previewState.value.entry).toEqual(entry);
    expect(previewState.value.textContent).toBeUndefined();
    expect(previewState.value.objectUrl).toBeUndefined();
  });

  it('loadPreview for a text file sets textContent and loaded state', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview({ client });
    const entry = makeEntry({ name: 'hello.txt', extension: '.txt', mimeCategory: 'text' });
    await loadPreview({ entry });
    expect(previewState.value.loadingState).toBe('loaded');
    expect(previewState.value.textContent).toBe('hello world');
    expect(previewState.value.entry).toEqual(entry);
  });

  it('loadPreview for a text file produces highlightedHtml via hljs', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview({ client });
    await loadPreview({ entry: makeEntry({ name: 'index.ts', extension: '.ts', mimeCategory: 'text' }) });
    expect(previewState.value.highlightedHtml).toBeDefined();
    expect(highlightMock).toHaveBeenCalledWith({
      request: {
        code: 'const x = 1;',
        language: 'typescript',
        mode: 'named-language',
      },
    });
  });

  it('loadPreview for text marks oversized when file exceeds TEXT_PREVIEW_SIZE_LIMIT', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview({ client });
    const entry = makeEntry({ name: 'big.txt', extension: '.txt', mimeCategory: 'text', size: TEXT_PREVIEW_SIZE_LIMIT + 1 });
    await loadPreview({ entry });
    expect(previewState.value.oversized).toBe(true);
    expect(previewState.value.loadingState).toBe('loaded');
    expect(previewState.value.textContent).toBeUndefined();
  });

  it('loadPreview formats JSON content by default', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview({ client });
    await loadPreview({ entry: makeEntry({ name: 'data.json', extension: '.json', mimeCategory: 'text' }) });
    expect(previewState.value.textContent).toContain('\n');
    expect(previewState.value.jsonFormatMode).toBe('formatted');
  });

  it.each<[MimeCategory, string]>([
    ['image', 'photo.png'],
    ['video', 'clip.mp4'],
    ['audio', 'song.mp3'],
  ])('loadPreview for %s creates an objectUrl', async (mimeCategory, name) => {
    const { previewState, loadPreview } = useFileExplorerPreview({ client });
    const ext = `.${name.split('.').pop()!}`;
    await loadPreview({ entry: makeEntry({ name, extension: ext, mimeCategory }) });
    expect(previewState.value.objectUrl).toBe('blob:fake-url');
    expect(previewState.value.loadingState).toBe('loaded');
  });

  it('loadPreview for media marks oversized when file exceeds MEDIA_PREVIEW_SIZE_LIMIT', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview({ client });
    const entry = makeEntry({ name: 'huge.mp4', extension: '.mp4', mimeCategory: 'video', size: MEDIA_PREVIEW_SIZE_LIMIT + 1 });
    await loadPreview({ entry });
    expect(previewState.value.oversized).toBe(true);
    expect(previewState.value.objectUrl).toBeUndefined();
  });

  it('loadPreview revokes previous objectUrl before loading new media', async () => {
    const { loadPreview } = useFileExplorerPreview({ client });
    const e1 = makeEntry({ name: 'photo.png', extension: '.png', mimeCategory: 'image' });
    const e2 = makeEntry({ name: 'clip.mp4', extension: '.mp4', mimeCategory: 'video' });
    await loadPreview({ entry: e1 });
    await loadPreview({ entry: e2 });
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:fake-url');
  });

  it('loadPreview for binary sets loaded state without content or objectUrl', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview({ client });
    await loadPreview({ entry: makeEntry({ name: 'data.bin', extension: '.bin', mimeCategory: 'binary' }) });
    expect(previewState.value.loadingState).toBe('loaded');
    expect(previewState.value.textContent).toBeUndefined();
    expect(previewState.value.objectUrl).toBeUndefined();
  });

  it('loadPreview sets error state when getFile throws', async () => {
    const { previewState, loadPreview } = useFileExplorerPreview({ client });
    await loadPreview({ entry: makeEntry({ name: 'broken.txt', extension: '.txt', mimeCategory: 'text' }) });
    expect(previewState.value.loadingState).toBe('error');
    expect(previewState.value.errorMessage).toContain('permission denied');
  });

  it('loadPreviewForced bypasses oversized guard for text files', async () => {
    const { previewState, loadPreviewForced } = useFileExplorerPreview({ client });
    const entry = makeEntry({ name: 'big.txt', extension: '.txt', mimeCategory: 'text', size: TEXT_PREVIEW_SIZE_LIMIT + 1 });
    await loadPreviewForced({ entry });
    expect(previewState.value.oversized).toBe(false);
    expect(previewState.value.textContent).toBe('big content');
  });

  it('loadPreviewForced is no-op for directories', async () => {
    const { previewState, loadPreviewForced } = useFileExplorerPreview({ client });
    const entry = makeEntry({ name: 'subdir', path: '/subdir', kind: 'directory', mimeCategory: 'binary', canNavigate: true });
    await loadPreviewForced({ entry });
    expect(previewState.value.loadingState).toBe('loaded');
  });

  it('toggleJsonFormat switches between raw and formatted', async () => {
    const { previewState, loadPreview, toggleJsonFormat } = useFileExplorerPreview({ client });
    await loadPreview({ entry: makeEntry({ name: 'data.json', extension: '.json', mimeCategory: 'text' }) });
    expect(previewState.value.jsonFormatMode).toBe('formatted');
    toggleJsonFormat();
    expect(previewState.value.jsonFormatMode).toBe('raw');
    toggleJsonFormat();
    expect(previewState.value.jsonFormatMode).toBe('formatted');
  });

  it('toggleJsonFormat is no-op when no entry is loaded', () => {
    const { previewState, toggleJsonFormat } = useFileExplorerPreview({ client });
    toggleJsonFormat();
    expect(previewState.value.jsonFormatMode).toBe('formatted');
  });

  it('toggleJsonFormat is no-op for non-JSON files', async () => {
    const { previewState, loadPreview, toggleJsonFormat } = useFileExplorerPreview({ client });
    await loadPreview({ entry: makeEntry({ name: 'hello.txt', extension: '.txt', mimeCategory: 'text' }) });
    const modeBefore = previewState.value.jsonFormatMode;
    toggleJsonFormat();
    expect(previewState.value.jsonFormatMode).toBe(modeBefore);
  });

  it('falls back to auto-detect when no extension language mapping exists', async () => {
    const { loadPreview } = useFileExplorerPreview({ client });
    await loadPreview({ entry: makeEntry({ name: 'hello.txt', extension: '.txt', mimeCategory: 'text' }) });
    expect(highlightMock).toHaveBeenCalledWith({
      request: {
        code: 'hello world',
        language: undefined,
        mode: 'auto-detect',
      },
    });
  });
});
