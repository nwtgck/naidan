import { WeshVFS } from '@/features/wesh/vfs';
import { TEXT_PREVIEW_SIZE_LIMIT } from '@/features/file-explorer/logic/constants';
import { receiveByteStream } from '@/utils/byte-stream-port';
import { MessageChannel } from 'node:worker_threads';
import JSZip from 'jszip';
import { describe, it, expect, beforeEach, vi } from 'vitest';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace the mapper dependency with the storage service API.
import { chatContentToDto, chatGroupToDto, chatMetaToDomain, chatMetaToDto } from '@/00-storage/mapper/mappers';
import { createFileExplorerWorker } from './impl';
import { ZipArchiveView } from './zip-archive-view';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import { OPFSStorageProvider } from '@/00-storage/service/opfs-storage';
import type { ChatContent, ChatGroup, ChatMeta } from '@/01-models/types';
import { renderChatMetadataMarkdown } from '@/features/wesh/naidan-sysfs/render/metadata-markdown';
import {
  naidanSysfsRemoteChatContentPayloadSchema,
  naidanSysfsRemoteChatGroupPayloadSchema,
  naidanSysfsRemoteChatMetaPayloadSchema,
} from '@/features/wesh/naidan-sysfs/remote-reader-schema';
import { toChatGroupId, toChatId, toMessageId } from '@/01-models/ids';

describe('file-explorer.worker.impl', () => {
  let worker: ReturnType<typeof createFileExplorerWorker>;

  beforeEach(() => {
    worker = createFileExplorerWorker();
  });

  it.each(['opfs-root', 'native-directory', 'wesh-mounts'] as const)('prepares a native File without reading its bytes from %s', async kind => {
    const root = new MockFileSystemDirectoryHandle({ name: 'download-root' });
    const handle = await root.getFileHandle('model.gguf', { create: true });
    handle.content = new Uint8Array([1]);
    if (kind === 'opfs-root') {
      vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    }
    const descriptor = kind === 'opfs-root' ? { kind, rootName: 'Files' }
      : kind === 'native-directory' ? { kind, rootName: 'Files', handle: root as unknown as FileSystemDirectoryHandle, readOnly: true }
        : { kind, rootName: 'Files', mounts: [{ type: 'directory' as const, path: '/mount', handle: root as unknown as FileSystemDirectoryHandle, readOnly: true }] };
    const { sessionId } = await worker.prepareSession({ request: { root: descriptor } });
    const directory = kind === 'wesh-mounts' ? '/mount' : '/';
    const path = kind === 'wesh-mounts' ? '/mount/model.gguf' : '/model.gguf';
    await using _cleanupResource = {
      async [Symbol.asyncDispose]() {
        await worker.disposeSession({ request: { sessionId } });
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
      },
    };
    const listing = await worker.readDirectory({ request: { sessionId, path: directory } });
    expect(listing.entries[0]!.size).toBe(1);
    handle.content = new Uint8Array([4, 5, 6]);
    const file = await handle.getFile();
    const getFile = vi.spyOn(handle, 'getFile').mockResolvedValue(file);
    const stream = vi.spyOn(file, 'stream');
    const buffer = vi.spyOn(file, 'arrayBuffer');
    const prepared = await worker.prepareFileDownload({ request: { sessionId, path } });
    expect(prepared.kind).toBe('file');
    if (prepared.kind !== 'file') {
      throw new Error('Expected a native File');
    }
    expect(prepared.blob).toBe(file);
    expect(prepared.blob.size).toBe(3);
    expect(getFile).toHaveBeenCalledOnce();
    expect(stream).not.toHaveBeenCalled();
    expect(buffer).not.toHaveBeenCalled();
    expect(await prepared.blob.text()).toBe(String.fromCharCode(4, 5, 6));
  });

  it('leaves a virtual file lazy without guessing Content-Length from stat', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'virtual' });
    const handle = await root.getFileHandle('file', { create: true });
    handle.content = new Uint8Array([1, 2, 3]);
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{ type: 'directory', path: '/mount', handle: root as unknown as FileSystemDirectoryHandle, readOnly: false }],
        },
      },
    });
    vi.spyOn(WeshVFS.prototype, 'getNativeHandle').mockResolvedValue(null);
    const open = vi.spyOn(WeshVFS.prototype, 'open');
    await using _cleanupResource = {
      async [Symbol.asyncDispose]() {
        await worker.disposeSession({ request: { sessionId } });
        vi.restoreAllMocks();
      },
    };
    expect(await worker.prepareFileDownload({ request: { sessionId, path: '/mount/file' } })).toEqual({ kind: 'stream' });
    expect(open).not.toHaveBeenCalled();
  });

  async function createZipBlob({ files }: { files: Record<string, string | Uint8Array> }): Promise<Blob> {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) {
      zip.file(name, content);
    }
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    return new Blob([Uint8Array.from(bytes).buffer]);
  }

  it('browses an archive root as a read-only virtual directory', async () => {
    const blob = await createZipBlob({
      files: {
        'src/index.ts': 'export const value = 1;',
        'README.md': '# demo',
      },
    });
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'archive-root',
          rootName: 'export.zip',
          archive: { format: 'zip', source: { kind: 'blob', blob } },
        },
      },
    });

    const root = await worker.readDirectory({ request: { sessionId, path: '/' } });
    expect(root.readOnly).toBe(true);
    expect(root.pathSegments).toEqual([
      { name: 'export.zip', path: '/', kind: 'archive' },
    ]);
    expect(root.entries.map(entry => [entry.name, entry.kind])).toEqual([
      ['src', 'directory'],
      ['README.md', 'file'],
    ]);

    const src = await worker.readDirectory({ request: { sessionId, path: '/src' } });
    expect(src.pathSegments).toEqual([
      { name: 'export.zip', path: '/', kind: 'archive' },
      { name: 'src', path: '/src', kind: 'directory' },
    ]);
    expect(src.entries.map(entry => entry.name)).toEqual(['index.ts']);

    const preview = await worker.readPreview({
      request: { sessionId, path: '/src/index.ts', mode: 'bounded' },
    });
    expect(preview).toMatchObject({
      kind: 'text',
      rawText: 'export const value = 1;',
      oversized: false,
    });
  });

  it('rejects archive roots whose entries escape the virtual root', async () => {
    const zip = new JSZip();
    zip.file('../escape.txt', 'nope');
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const blob = new Blob([Uint8Array.from(bytes).buffer]);

    await expect(worker.prepareSession({
      request: {
        root: {
          kind: 'archive-root',
          rootName: 'unsafe.zip',
          archive: { format: 'zip', source: { kind: 'blob', blob } },
        },
      },
    })).rejects.toThrow(/archive root|escapes|path/u);
  });

  it('keeps ZIP file downloads lazy and streams their original content', async () => {
    const blob = await createZipBlob({ files: { 'docs/note.txt': 'streamed from ZIP' } });
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'archive-root',
          rootName: 'export.zip',
          archive: { format: 'zip', source: { kind: 'blob', blob } },
        },
      },
    });
    const readBlob = vi.spyOn(ZipArchiveView.prototype, 'readFileBlob');
    const openStream = vi.spyOn(ZipArchiveView.prototype, 'openFileStream');
    const channel = new MessageChannel();
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        readBlob.mockRestore();
        openStream.mockRestore();
        channel.port1.close();
        channel.port2.close();
        await worker.disposeSession({ request: { sessionId } });
      },
    };
    expect(await worker.prepareFileDownload({ request: { sessionId, path: '/docs/note.txt' } }))
      .toEqual({ kind: 'stream' });
    expect(readBlob).not.toHaveBeenCalled();
    expect(openStream).not.toHaveBeenCalled();

    const received = receiveByteStream({ port: channel.port1 as unknown as MessagePort });
    const text = new Response(received.stream).text();
    await worker.streamFile({
      request: { sessionId, path: '/docs/note.txt' },
      port: channel.port2 as unknown as MessagePort,
    });
    expect(await text).toBe('streamed from ZIP');
    expect(readBlob).not.toHaveBeenCalled();
  });

  it('preserves whitespace in ZIP directory and file names', async () => {
    const blob = await createZipBlob({ files: { ' folder /note.txt ': 'spaced path' } });
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'archive-root',
          rootName: 'export.zip',
          archive: { format: 'zip', source: { kind: 'blob', blob } },
        },
      },
    });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await worker.disposeSession({ request: { sessionId } });
      },
    };
    const listing = await worker.readDirectory({ request: { sessionId, path: '/ folder ' } });
    expect(listing.entries.map(entry => entry.name)).toEqual(['note.txt ']);
    const file = await worker.readFile({ request: { sessionId, path: '/ folder /note.txt ' } });
    expect(await file.blob.text()).toBe('spaced path');
  });

  it('distinguishes ordinary files from ZIP parsing failures during directory probes', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'files' });
    (await root.getFileHandle('note.txt', { create: true })).content = new TextEncoder().encode('plain text');
    (await root.getFileHandle('broken.zip', { create: true })).content = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: root as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await worker.disposeSession({ request: { sessionId } });
      },
    };
    await expect(worker.readDirectory({ request: { sessionId, path: '/note.txt' } }))
      .rejects.toMatchObject({ name: 'FileExplorerNotDirectoryError' });
    await expect(worker.readDirectory({ request: { sessionId, path: '/broken.zip' } }))
      .rejects.not.toMatchObject({ name: 'FileExplorerNotDirectoryError' });
    await expect(worker.readDirectory({ request: { sessionId, path: '/missing' } }))
      .rejects.not.toMatchObject({ name: 'FileExplorerNotDirectoryError' });
  });

  it('rejects oversized ZIP previews before reading the entry and skips binary payloads', async () => {
    const blob = await createZipBlob({
      files: {
        'large.txt': 'x'.repeat(TEXT_PREVIEW_SIZE_LIMIT + 1),
        'unsupported.bin': new Uint8Array([1, 2, 3]),
      },
    });
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'archive-root',
          rootName: 'export.zip',
          archive: { format: 'zip', source: { kind: 'blob', blob } },
        },
      },
    });
    const openStream = vi.spyOn(ZipArchiveView.prototype, 'openFileStream');
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        openStream.mockRestore();
        await worker.disposeSession({ request: { sessionId } });
      },
    };
    expect(await worker.readPreview({ request: { sessionId, path: '/large.txt', mode: 'bounded' } }))
      .toMatchObject({ kind: 'text', oversized: true, rawText: '' });
    expect(await worker.readPreview({ request: { sessionId, path: '/unsupported.bin', mode: 'bounded' } }))
      .toEqual({ kind: 'binary', oversized: false });
    expect(openStream).not.toHaveBeenCalled();
  });

  it('preserves nested Wesh mount contents and permissions beneath native directories', async () => {
    const parent = new MockFileSystemDirectoryHandle({ name: 'parent' });
    const hidden = await parent.getDirectoryHandle('child', { create: true });
    (await hidden.getFileHandle('wrong.txt', { create: true })).content = new TextEncoder().encode('hidden');
    const child = new MockFileSystemDirectoryHandle({ name: 'child-mount' });
    (await child.getFileHandle('note.txt', { create: true })).content = new TextEncoder().encode('mounted');
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [
            { type: 'directory', path: '/parent', handle: parent as unknown as FileSystemDirectoryHandle, readOnly: false },
            { type: 'directory', path: '/parent/child', handle: child as unknown as FileSystemDirectoryHandle, readOnly: true },
          ],
        },
      },
    });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await worker.disposeSession({ request: { sessionId } });
      },
    };
    const listing = await worker.readDirectory({ request: { sessionId, path: '/parent/child' } });
    expect(listing.readOnly).toBe(true);
    expect(listing.entries.map(entry => entry.name)).toEqual(['note.txt']);
    const prepared = await worker.prepareFileDownload({ request: { sessionId, path: '/parent/child/note.txt' } });
    expect(prepared.kind).toBe('file');
    if (prepared.kind !== 'file') {
      throw new Error('Expected a native File from the nested mount');
    }
    expect(await prepared.blob.text()).toBe('mounted');
    await expect(worker.createFile({ request: { sessionId, parentPath: '/parent/child', name: 'blocked.txt' } }))
      .rejects.toThrow('Read-only file system');
    await expect(hidden.getFileHandle('blocked.txt')).rejects.toThrow();
    await expect(child.getFileHandle('blocked.txt')).rejects.toThrow();
  });

  it('browses ZIP contents through a Wesh source without a native handle', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'virtual' });
    const archive = await root.getFileHandle('bundle.data', { create: true });
    archive.content = new Uint8Array(await (await createZipBlob({ files: { 'docs/note.txt': 'virtual ZIP' } })).arrayBuffer());
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{ type: 'directory', path: '/mount', handle: root as unknown as FileSystemDirectoryHandle, readOnly: true }],
        },
      },
    });
    const nativeHandle = vi.spyOn(WeshVFS.prototype, 'getNativeHandle').mockResolvedValue(null);
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        nativeHandle.mockRestore();
        await worker.disposeSession({ request: { sessionId } });
      },
    };
    const listing = await worker.readDirectory({ request: { sessionId, path: '/mount/bundle.data/docs' } });
    expect(listing.readOnly).toBe(true);
    expect(listing.pathSegments).toEqual([
      { name: 'Files', path: '/', kind: 'root' },
      { name: 'mount', path: '/mount', kind: 'directory' },
      { name: 'bundle.data', path: '/mount/bundle.data', kind: 'archive' },
      { name: 'docs', path: '/mount/bundle.data/docs', kind: 'directory' },
    ]);
    expect(listing.entries.map(entry => entry.name)).toEqual(['note.txt']);
    expect(await worker.readPreview({ request: { sessionId, path: '/mount/bundle.data/docs/note.txt', mode: 'bounded' } }))
      .toMatchObject({ kind: 'text', rawText: 'virtual ZIP', oversized: false });
  });

  it('browses nested ZIP containers without relying on the file extension', async () => {
    const innerBlob = await createZipBlob({
      files: {
        'xl/workbook.xml': '<workbook />',
      },
    });
    const outerZip = new JSZip();
    outerZip.file('report.data', new Uint8Array(await innerBlob.arrayBuffer()));
    outerZip.file('plain.txt', 'not an archive');
    const outerBytes = await outerZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const outerBlob = new Blob([Uint8Array.from(outerBytes).buffer]);

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'archive-root',
          rootName: 'outer.zip',
          archive: { format: 'zip', source: { kind: 'blob', blob: outerBlob } },
        },
      },
    });

    const nestedRoot = await worker.readDirectory({
      request: { sessionId, path: '/report.data' },
    });
    expect(nestedRoot.pathSegments).toEqual([
      { name: 'outer.zip', path: '/', kind: 'archive' },
      { name: 'report.data', path: '/report.data', kind: 'archive' },
    ]);
    expect(nestedRoot.entries.map(entry => entry.name)).toEqual(['xl']);

    const readFileBlobSpy = vi.spyOn(ZipArchiveView.prototype, 'readFileBlob')
      .mockRejectedValue(new Error('cached nested archive should not be materialized again'));
    try {
      const nestedDirectory = await worker.readDirectory({
        request: { sessionId, path: '/report.data/xl' },
      });
      expect(nestedDirectory.entries.map(entry => entry.name)).toEqual(['workbook.xml']);
      expect(readFileBlobSpy).not.toHaveBeenCalled();
    } finally {
      readFileBlobSpy.mockRestore();
    }

    await expect(worker.readDirectory({
      request: { sessionId, path: '/plain.txt' },
    })).rejects.toMatchObject({ name: 'FileExplorerNotDirectoryError' });
  });

  it('rejects oversized nested ZIP materialization before reading the full entry', async () => {
    const innerBlob = await createZipBlob({ files: { 'inside.txt': 'small fixture' } });
    const outerZip = new JSZip();
    outerZip.file('huge.data', new Uint8Array(await innerBlob.arrayBuffer()));
    const outerBytes = await outerZip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const outerBlob = new Blob([Uint8Array.from(outerBytes).buffer]);

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'archive-root',
          rootName: 'outer.zip',
          archive: { format: 'zip', source: { kind: 'blob', blob: outerBlob } },
        },
      },
    });

    const getFileSizeSpy = vi.spyOn(ZipArchiveView.prototype, 'getFileSize')
      .mockReturnValue(Number.MAX_SAFE_INTEGER);
    const readFileBlobSpy = vi.spyOn(ZipArchiveView.prototype, 'readFileBlob');
    try {
      await expect(worker.readDirectory({
        request: { sessionId, path: '/huge.data' },
      })).rejects.toThrow('Nested ZIP is too large to browse safely');
      expect(readFileBlobSpy).not.toHaveBeenCalled();
    } finally {
      getFileSizeSpy.mockRestore();
      readFileBlobSpy.mockRestore();
    }
  });

  it('invalidates a cached native archive when the file changes', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const archiveHandle = await rootHandle.getFileHandle('changing.data', { create: true });
    const firstBlob = await createZipBlob({ files: { 'first.txt': 'one' } });
    let writable = await archiveHandle.createWritable();
    await writable.write(await firstBlob.arrayBuffer());
    await writable.close();

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    const first = await worker.readDirectory({ request: { sessionId, path: '/changing.data' } });
    expect(first.entries.map(entry => entry.name)).toEqual(['first.txt']);

    const secondBlob = await createZipBlob({ files: { 'second-longer-name.txt': 'two' } });
    writable = await archiveHandle.createWritable();
    await writable.write(await secondBlob.arrayBuffer());
    await writable.close();

    const second = await worker.readDirectory({ request: { sessionId, path: '/changing.data' } });
    expect(second.entries.map(entry => entry.name)).toEqual(['second-longer-name.txt']);
  });

  it('lists native directory entries with metadata', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const fileHandle = await rootHandle.getFileHandle('readme.txt', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('hello');
    await writable.close();
    await rootHandle.getDirectoryHandle('docs', { create: true });

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    const response = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    });

    expect(response.entries.map(entry => entry.name).sort()).toEqual(['docs', 'readme.txt']);
    expect(response.entries.find(entry => entry.name === 'readme.txt')?.size).toBe(5);
  });

  it('rejects ZIP execution when a same-kind target appeared after preview', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });
    const zip = new JSZip();
    zip.file('note.txt', 'from zip');
    const blob = new Blob([
      Uint8Array.from(await zip.generateAsync({ type: 'uint8array' })).buffer,
    ]);

    await worker.analyzeZipUpload({
      request: {
        sessionId,
        analysisId: 'zip-analysis-1',
        targetDirectoryPath: '/',
        fileName: 'upload.zip',
        blob,
      },
    });
    await worker.readZipUploadPreviewDirectory({
      request: {
        sessionId,
        analysisId: 'zip-analysis-1',
        placement: { kind: 'extract', rootHandling: 'not_applicable' },
        relativePath: '',
      },
    });

    const targetFile = await rootHandle.getFileHandle('note.txt', { create: true });
    const writable = await targetFile.createWritable();
    await writable.write('external change');
    await writable.close();

    await expect(worker.executeZipUpload({
      request: {
        sessionId,
        analysisId: 'zip-analysis-1',
        jobId: 'zip-job-1',
        placement: { kind: 'extract', rootHandling: 'not_applicable' },
      },
    })).resolves.toEqual({ status: 'preview_outdated' });
    expect(await (await targetFile.getFile()).text()).toBe('external change');
  });

  it('keeps global ZIP conflicts visible while previewing another directory', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const left = await rootHandle.getDirectoryHandle('left', { create: true });
    const conflicting = await left.getFileHandle('nested', { create: true });
    const conflictingWritable = await conflicting.createWritable();
    await conflictingWritable.write('file instead of directory');
    await conflictingWritable.close();
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });
    const zip = new JSZip();
    zip.file('left/nested/file.txt', 'blocked');
    zip.file('right/file.txt', 'safe');
    const blob = new Blob([
      Uint8Array.from(await zip.generateAsync({ type: 'uint8array' })).buffer,
    ]);

    await worker.analyzeZipUpload({
      request: {
        sessionId,
        analysisId: 'zip-analysis-global-conflict',
        targetDirectoryPath: '/',
        fileName: 'upload.zip',
        blob,
      },
    });
    const response = await worker.readZipUploadPreviewDirectory({
      request: {
        sessionId,
        analysisId: 'zip-analysis-global-conflict',
        placement: { kind: 'extract', rootHandling: 'not_applicable' },
        relativePath: 'right',
      },
    });

    expect(response.entries.map(entry => entry.name)).toEqual(['file.txt']);
    expect(response.summary.blockedCount).toBe(1);
  });

  it('suggests descendants and archives a directory with its own root', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const projectHandle = await rootHandle.getDirectoryHandle('my-project', { create: true });
    const srcHandle = await projectHandle.getDirectoryHandle('src', { create: true });
    const sourceFileHandle = await srcHandle.getFileHandle('main.ts', { create: true });
    const sourceWritable = await sourceFileHandle.createWritable();
    await sourceWritable.write('export const value = 1;');
    await sourceWritable.close();
    const distHandle = await projectHandle.getDirectoryHandle('dist', { create: true });
    const generatedFileHandle = await distHandle.getFileHandle('generated.js', { create: true });
    const generatedWritable = await generatedFileHandle.createWritable();
    await generatedWritable.write('generated');
    await generatedWritable.close();

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    const suggestions = await worker.suggestArchiveExclusions({
      request: {
        sessionId,
        directoryPath: '/my-project',
        query: 'sr',
        excludedRelativePaths: [],
      },
    });
    expect(suggestions).toEqual({
      suggestions: [{
        relativePath: 'src',
        name: 'src',
        kind: 'directory',
      }],
      resultState: 'complete',
    });

    const nestedSuggestions = await worker.suggestArchiveExclusions({
      request: {
        sessionId,
        directoryPath: '/my-project',
        query: 'src/ma',
        excludedRelativePaths: [],
      },
    });
    expect(nestedSuggestions).toEqual({
      suggestions: [{
        relativePath: 'src/main.ts',
        name: 'main.ts',
        kind: 'file',
      }],
      resultState: 'complete',
    });

    const channel = new MessageChannel();
    const received = receiveByteStream({ port: channel.port1 as unknown as MessagePort });
    const bytesPromise = new Response(received.stream).arrayBuffer();
    const archive = await worker.createDirectoryArchive({
      port: channel.port2 as unknown as MessagePort,
      request: {
        sessionId,
        jobId: 'archive-job-1',
        directoryPath: '/my-project',
        excludedRelativePaths: ['dist'],
      },
    });
    expect(archive.status).toBe('completed');
    if (archive.status !== 'completed') {
      throw new Error('Expected a completed archive');
    }

    const zipBytes = Uint8Array.from(new Uint8Array(await bytesPromise));
    const zip = await JSZip.loadAsync(zipBytes);
    expect(Object.keys(zip.files)).toContain('my-project/');
    expect(Object.keys(zip.files)).toContain('my-project/src/');
    expect(await zip.file('my-project/src/main.ts')?.async('text')).toBe('export const value = 1;');
    expect(Object.keys(zip.files).some(path => path.startsWith('my-project/dist/'))).toBe(false);
  });

  it('lists exclusion suggestions without reading file metadata', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const projectHandle = await rootHandle.getDirectoryHandle('project', { create: true });
    const fileHandle = await projectHandle.getFileHandle('readme.txt', { create: true });
    const getFile = vi.spyOn(fileHandle, 'getFile');

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    const suggestions = await worker.suggestArchiveExclusions({
      request: {
        sessionId,
        directoryPath: '/project',
        query: '',
        excludedRelativePaths: [],
      },
    });

    expect(suggestions.suggestions).toContainEqual({
      relativePath: 'readme.txt',
      name: 'readme.txt',
      kind: 'file',
    });
    expect(getFile).not.toHaveBeenCalled();
  });

  it('does not resolve an unsafe parent path while suggesting exclusions', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    await expect(worker.suggestArchiveExclusions({
      request: {
        sessionId,
        directoryPath: '/',
        query: 'unsafe\\segment/',
        excludedRelativePaths: [],
      },
    })).resolves.toEqual({
      suggestions: [],
      resultState: 'complete',
    });
  });

  it('does not traverse a directory that is already excluded', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    await expect(worker.suggestArchiveExclusions({
      request: {
        sessionId,
        directoryPath: '/',
        query: 'missing/',
        excludedRelativePaths: ['missing'],
      },
    })).resolves.toEqual({
      suggestions: [],
      resultState: 'complete',
    });
  });

  it('reads text previews and formats JSON', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const fileHandle = await rootHandle.getFileHandle('data.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('{"a":1}');
    await writable.close();

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    const response = await worker.readPreview({
      request: {
        sessionId,
        path: '/data.json',
        mode: 'bounded',
      },
    });

    expect(response.kind).toBe('text');
    if (response.kind === 'text') {
      expect(response.rawText).toBe('{"a":1}');
      expect(response.displayText).toContain('\n');
    }
  });

  it('copies files and directories out of a ZIP virtual directory', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const targetHandle = await rootHandle.getDirectoryHandle('target', { create: true });
    const archiveHandle = await rootHandle.getFileHandle('bundle.zip', { create: true });
    const archiveBlob = await createZipBlob({
      files: {
        'top.txt': 'top level',
        'docs/readme.txt': 'nested readme',
      },
    });
    const writable = await archiveHandle.createWritable();
    await writable.write(await archiveBlob.arrayBuffer());
    await writable.close();

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    await worker.copyEntries({
      request: {
        sessionId,
        sourcePaths: ['/bundle.zip/top.txt', '/bundle.zip/docs'],
        targetDirectoryPath: '/target',
      },
    });

    expect(await (await targetHandle.getFileHandle('top.txt')).getFile().then(file => file.text())).toBe('top level');
    const copiedDocs = await targetHandle.getDirectoryHandle('docs');
    expect(await (await copiedDocs.getFileHandle('readme.txt')).getFile().then(file => file.text())).toBe('nested readme');
  });

  it('rejects moving a ZIP entry before copying it into the writable target', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const targetHandle = await rootHandle.getDirectoryHandle('target', { create: true });
    const archiveHandle = await rootHandle.getFileHandle('bundle.zip', { create: true });
    const archiveBlob = await createZipBlob({ files: { 'inside.txt': 'read only' } });
    const writable = await archiveHandle.createWritable();
    await writable.write(await archiveBlob.arrayBuffer());
    await writable.close();

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    await expect(worker.moveEntries({
      request: {
        sessionId,
        sourcePaths: ['/bundle.zip/inside.txt'],
        targetDirectoryPath: '/target',
      },
    })).rejects.toThrow('Read-only file system');

    await expect(targetHandle.getFileHandle('inside.txt')).rejects.toThrow();
  });

  it('copies a nested ZIP container as the original file rather than extracting it', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    const targetHandle = await rootHandle.getDirectoryHandle('target', { create: true });
    const archiveHandle = await rootHandle.getFileHandle('outer.zip', { create: true });
    const innerBlob = await createZipBlob({ files: { 'inside.txt': 'nested' } });
    const outerBlob = await createZipBlob({
      files: {
        'inner.data': new Uint8Array(await innerBlob.arrayBuffer()),
      },
    });
    const writable = await archiveHandle.createWritable();
    await writable.write(await outerBlob.arrayBuffer());
    await writable.close();

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    await worker.copyEntries({
      request: {
        sessionId,
        sourcePaths: ['/outer.zip/inner.data'],
        targetDirectoryPath: '/target',
      },
    });

    const copiedFile = await (await targetHandle.getFileHandle('inner.data')).getFile();
    const copiedBytes = new Uint8Array(await copiedFile.arrayBuffer());
    expect(copiedBytes).toEqual(new Uint8Array(await innerBlob.arrayBuffer()));
    await expect(targetHandle.getDirectoryHandle('inner.data')).rejects.toThrow();
  });

  it('creates, copies, moves, and deletes entries inside a session', async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    await rootHandle.getDirectoryHandle('target', { create: true });

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'native-directory',
          rootName: 'Files',
          handle: rootHandle as unknown as FileSystemDirectoryHandle,
          readOnly: false,
        },
      },
    });

    await worker.createFile({
      request: {
        sessionId,
        parentPath: '/',
        name: 'source.txt',
      },
    });

    await worker.copyEntries({
      request: {
        sessionId,
        sourcePaths: ['/source.txt'],
        targetDirectoryPath: '/target',
      },
    });

    let targetListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/target',
      },
    });
    expect(targetListing.entries.map(entry => entry.name)).toContain('source.txt');

    await worker.moveEntries({
      request: {
        sessionId,
        sourcePaths: ['/source.txt'],
        targetDirectoryPath: '/target',
      },
    });

    const rootListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    });
    expect(rootListing.entries.map(entry => entry.name)).not.toContain('source.txt');

    await worker.deleteEntries({
      request: {
        sessionId,
        paths: ['/target/source.txt'],
      },
    });

    targetListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/target',
      },
    });
    expect(targetListing.entries.map(entry => entry.name)).not.toContain('source.txt');
  });

  it('bounds virtual text preview reads before buffering and never reads unsupported binary previews', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'large-preview' });
    for (const name of ['large.txt', 'large.bin']) {
      const file = await root.getFileHandle(name, { create: true });
      file.content = new Uint8Array(TEXT_PREVIEW_SIZE_LIMIT + 1024 * 1024);
    }
    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{
            type: 'directory',
            path: '/preview',
            handle: root as unknown as FileSystemDirectoryHandle,
            readOnly: true,
          }],
        },
      },
    });
    const nativeHandle = vi.spyOn(WeshVFS.prototype, 'getNativeHandle').mockResolvedValue(null);
    const originalOpen = WeshVFS.prototype.open;
    let bytesRead = 0;
    const opened = vi.spyOn(WeshVFS.prototype, 'open').mockImplementation(async function (this: WeshVFS, input) {
      const handle = await originalOpen.call(this, input);
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async input => {
        const result = await originalRead(input);
        bytesRead += result.bytesRead;
        return result;
      });
      return handle;
    });
    await using _cleanupResource = {
      async [Symbol.asyncDispose]() {
        opened.mockRestore();
        nativeHandle.mockRestore();
        await worker.disposeSession({ request: { sessionId } });
      },
    };
    expect(await worker.readPreview({ request: { sessionId, path: '/preview/large.txt', mode: 'bounded' } }))
      .toMatchObject({ kind: 'text', oversized: true, rawText: '' });
    expect(bytesRead).toBe(TEXT_PREVIEW_SIZE_LIMIT + 1);
    const calls = opened.mock.calls.length;
    expect(await worker.readPreview({ request: { sessionId, path: '/preview/large.bin', mode: 'bounded' } }))
      .toEqual({ kind: 'binary', oversized: false });
    expect(opened).toHaveBeenCalledTimes(calls);
  });

  it('exposes virtual directories for wesh mounts roots', async () => {
    const mountHandle = new MockFileSystemDirectoryHandle({ name: 'project' });
    const fileHandle = await mountHandle.getFileHandle('index.ts', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write('export {}');
    await writable.close();

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{
            type: 'directory',
            path: '/home/user/project',
            handle: mountHandle as unknown as FileSystemDirectoryHandle,
            readOnly: false,
          }],
        },
      },
    });

    const rootListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    });
    expect(rootListing.entries.map(entry => entry.name)).toEqual(['home']);

    const mountListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/home/user/project',
      },
    });
    expect(mountListing.entries.map(entry => entry.name)).toEqual(['index.ts']);
  });

  it('lists and navigates naidan sysfs entries from wesh mounts', async () => {
    const opfsRoot = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const storageRoot = await opfsRoot.getDirectoryHandle('naidan-storage', { create: true });
    await storageRoot.getDirectoryHandle('uploaded-files', { create: true });
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        storage: {
          getDirectory: async () => opfsRoot as unknown as FileSystemDirectoryHandle,
        },
      },
      configurable: true,
    });

    const provider = new OPFSStorageProvider();
    await provider.init();
    const chatMeta: ChatMeta = {
      id: toChatId({ raw: 'chat-1' }),
      title: 'Main Chat',
      groupId: toChatGroupId({ raw: 'chat-group-1' }),
      currentLeafId: toMessageId({ raw: 'assistant-1' }),
      createdAt: 100,
      updatedAt: 200,
      debugEnabled: false,
      endpoint: {
        type: 'openai',
        url: 'https://example.invalid/v1',
        httpHeaders: [['Authorization', 'secret-token']],
      },
      modelId: 'gpt-5',
      titleGeneration: { endpoint: 'same_scope', model: { id: 'gpt-5-mini' }, lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      originChatId: undefined,
      originMessageId: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      mounts: [],
    };
    const chatContent: ChatContent = {
      currentLeafId: toMessageId({ raw: 'assistant-1' }),
      root: {
        items: [{
          id: toMessageId({ raw: 'user-1' }),
          role: 'user',
          parts: [{ type: 'text', text: 'Hello', completeness: 'complete' }],
          createdAt: 1000,
          modelId: undefined,
          lmParameters: undefined,
          replies: {
            items: [{
              id: toMessageId({ raw: 'assistant-1' }),
              role: 'assistant',
              parts: [{ type: 'text', text: 'Hi', completeness: 'complete' }],
              createdAt: 1001,
              modelId: 'gpt-5',
              lmParameters: undefined,
              interruption: undefined,
              replies: { items: [] },
            }],
          },
        }],
      },
    };
    const chatGroup: ChatGroup = {
      id: toChatGroupId({ raw: 'chat-group-1' }),
      name: 'Research',
      isCollapsed: false,
      updatedAt: 200,
      mounts: [],
      endpoint: {
        type: 'openai',
        url: 'https://example.invalid/v1',
        httpHeaders: [['Authorization', 'group-secret-token']],
      },
      modelId: 'gpt-5',
      titleGeneration: { endpoint: 'same_scope', model: { id: 'gpt-5-mini' }, lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      systemPrompt: undefined,
      lmParameters: undefined,
      items: [
        {
          id: 'chat:chat-1',
          type: 'chat',
          chat: {
            id: toChatId({ raw: 'chat-1' }),
            title: 'Main Chat',
            updatedAt: 200,
            groupId: toChatGroupId({ raw: 'chat-group-1' }),
          },
        },
      ],
    };
    await provider.saveChatMeta({ meta: chatMeta });
    await provider.saveChatContent({ id: chatMeta.id, content: chatContent });
    await provider.saveChatGroup({ chatGroup });
    await provider.saveHierarchy({
      hierarchy: {
        items: [{
          type: 'chat_group',
          id: 'chat-group-1',
          chat_ids: ['chat-1'],
        }],
      },
    });
    const storedChatMeta = await provider.loadChatMeta({ id: toChatId({ raw: 'chat-1' }) });

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{
            type: 'naidan_sysfs',
            path: '/sys/fs/naidan',
            readOnly: true,
            storageType: 'opfs',
            visibility: 'current_chat_with_chat_group',
            binaryObjectAccess: 'data',
            currentChatId: 'chat-1',
            currentChatGroupId: 'chat-group-1',
          }],
        },
      },
    });

    const rootListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/',
      },
    });
    expect(rootListing.entries.map(entry => entry.name)).toEqual(['sys']);

    const sysfsListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/sys/fs/naidan',
      },
    });
    expect(sysfsListing.entries.map(entry => entry.name)).toEqual([
      'version',
      'current-chat',
      'chats',
      'hierarchy',
      'binary-objects',
      'current-chat-group',
      'chat-groups',
    ]);
    expect(sysfsListing.entries.find(entry => entry.name === 'current-chat')).toEqual({
      path: '/sys/fs/naidan/current-chat',
      name: 'current-chat',
      kind: 'directory',
      size: undefined,
      lastModified: undefined,
      extension: '',
      mimeCategory: 'binary',
      readOnly: true,
      canNavigate: true,
      canMutate: false,
    });

    const currentChatListing = await worker.readDirectory({
      request: {
        sessionId,
        path: '/sys/fs/naidan/current-chat',
      },
    });
    expect(currentChatListing.entries.map(entry => entry.name)).toEqual([
      'metadata.md',
      'metadata.json',
      'content-md',
      'content-json',
      'branches',
    ]);

    const metadataPreview = await worker.readPreview({
      request: {
        sessionId,
        path: '/sys/fs/naidan/current-chat/metadata.md',
        mode: 'bounded',
      },
    });
    expect(metadataPreview.kind).toBe('text');
    if (metadataPreview.kind === 'text') {
      expect(metadataPreview.rawText).toBe(renderChatMetadataMarkdown({ metadata: storedChatMeta! }));
      expect(metadataPreview.displayText).toBe(renderChatMetadataMarkdown({ metadata: storedChatMeta! }));
    }
  });

  it('reads naidan sysfs metadata through a local remote reader', async () => {
    const chatMeta: ChatMeta = {
      id: toChatId({ raw: 'chat-1' }),
      title: 'Local Chat',
      groupId: toChatGroupId({ raw: 'chat-group-1' }),
      currentLeafId: toMessageId({ raw: 'a1chatMetadataAbCdEf' }),
      createdAt: 100,
      updatedAt: 200,
      debugEnabled: false,
      endpoint: {
        type: 'openai',
        url: 'https://example.invalid/v1',
        httpHeaders: [['Authorization', 'secret-token']],
      },
      modelId: 'gpt-5',
      titleGeneration: { endpoint: 'same_scope', model: { id: 'gpt-5-mini' }, lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      originChatId: undefined,
      originMessageId: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      mounts: [],
    };
    const chatContent: ChatContent = {
      currentLeafId: toMessageId({ raw: 'a1chatMetadataAbCdEf' }),
      root: { items: [] },
    };
    const chatGroup: ChatGroup = {
      id: toChatGroupId({ raw: 'chat-group-1' }),
      name: 'Local Group',
      isCollapsed: false,
      updatedAt: 200,
      mounts: [],
      endpoint: undefined,
      modelId: undefined,
      titleGeneration: 'inherit',
      systemPrompt: undefined,
      lmParameters: undefined,
      items: [{
        id: 'chat:chat-1',
        type: 'chat',
        chat: {
          id: toChatId({ raw: 'chat-1' }),
          title: 'Local Chat',
          updatedAt: 200,
          groupId: toChatGroupId({ raw: 'chat-group-1' }),
        },
      }],
    };
    const expectedMetadata = chatMetaToDomain({ dto: chatMetaToDto({ domain: chatMeta }) });
    expectedMetadata.groupId = toChatGroupId({ raw: 'chat-group-1' });
    const remoteMetadata = naidanSysfsRemoteChatMetaPayloadSchema.parse({
      dto: chatMetaToDto({ domain: chatMeta }),
      groupId: 'chat-group-1',
    });
    const remoteContent = naidanSysfsRemoteChatContentPayloadSchema.parse(chatContentToDto({ domain: chatContent }));
    const remoteGroup = naidanSysfsRemoteChatGroupPayloadSchema.parse({
      dto: chatGroupToDto({ domain: chatGroup }),
      items: chatGroup.items,
    });

    const { sessionId } = await worker.prepareSession({
      request: {
        root: {
          kind: 'wesh-mounts',
          rootName: 'Files',
          mounts: [{
            type: 'naidan_sysfs',
            path: '/sys/fs/naidan',
            readOnly: true,
            storageType: 'local',
            visibility: 'current_chat_only',
            binaryObjectAccess: 'data',
            currentChatId: 'chat-1',
            currentChatGroupId: 'chat-group-1',
          }],
        },
      },
    }, {
      storageType: 'local',
      async getSidebarStructure() {
        return [{
          id: 'chat-group:chat-group-1',
          type: 'chat_group',
          chatGroup: remoteGroup,
        }];
      },
      async listChats() {
        return [{
          id: 'chat-1',
          title: 'Local Chat',
          updatedAt: 200,
          groupId: 'chat-group-1',
        }];
      },
      async listChatGroups() {
        return [remoteGroup];
      },
      async loadChatMeta({ chatId }: { chatId: string }) {
        return chatId === 'chat-1' ? remoteMetadata : undefined;
      },
      async loadChatContent({ chatId }: { chatId: string }) {
        return chatId === 'chat-1' ? remoteContent : undefined;
      },
      async loadChat({ chatId }: { chatId: string }) {
        return chatId === 'chat-1' ? { metadata: remoteMetadata, content: remoteContent } : undefined;
      },
      async loadChatGroup({ chatGroupId }: { chatGroupId: string }) {
        return chatGroupId === 'chat-group-1' ? remoteGroup : undefined;
      },
      async listBinaryObjects() {
        return [];
      },
      async getBinaryObject() {
        return undefined;
      },
      async getBinaryObjectBlob() {
        return undefined;
      },
    });

    const metadataPreview = await worker.readPreview({
      request: {
        sessionId,
        path: '/sys/fs/naidan/chats/chat-1/metadata.md',
        mode: 'bounded',
      },
    });

    expect(metadataPreview).toEqual({
      kind: 'text',
      rawText: renderChatMetadataMarkdown({ metadata: expectedMetadata }),
      displayText: renderChatMetadataMarkdown({ metadata: expectedMetadata }),
      languageHint: 'markdown',
      oversized: false,
    });
  });
});
