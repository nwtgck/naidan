import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { createBlobZipSource } from '@/utils/zip-stream';
import { ZipArchiveView } from './zip-archive-view';

async function createZipBlob({ files }: { files: Record<string, string> }): Promise<Blob> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content, { createFolders: false });
  }
  return new Blob([Uint8Array.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })).buffer]);
}

describe('ZipArchiveView', () => {
  it.each(['../escape.txt', '/absolute.txt', 'C:/absolute.txt', 'nul\0.txt'])('rejects unsafe archive paths: %s', async name => {
    const blob = await createZipBlob({ files: { [name]: 'unsafe' } });
    await expect(ZipArchiveView.open({ blob })).rejects.toThrow(/path|NUL|escapes/u);
  });

  it('rejects duplicate normalized paths and file-directory conflicts', async () => {
    const duplicate = await createZipBlob({ files: { 'docs//note.txt': 'one', 'docs/note.txt': 'two' } });
    await expect(ZipArchiveView.open({ blob: duplicate })).rejects.toThrow('duplicate path');
    const conflict = await createZipBlob({ files: { docs: 'file', 'docs/note.txt': 'child' } });
    await expect(ZipArchiveView.open({ blob: conflict })).rejects.toThrow('also used as a directory');
  });

  it('bounds implicit directory growth while reusing shared parents', async () => {
    const parents = Array.from({ length: 126 }, () => 'p').join('/');
    const separateParents = await createZipBlob({
      files: Object.fromEntries(Array.from({ length: 800 }, (_, index) => [`branch-${index}/${parents}/note.txt`, 'small'])),
    });
    await expect(ZipArchiveView.open({ blob: separateParents })).rejects.toThrow('too many files and directories');

    const sharedParents = await createZipBlob({
      files: Object.fromEntries(Array.from({ length: 800 }, (_, index) => [`shared/${parents}/note-${index}.txt`, 'small'])),
    });
    const view = await ZipArchiveView.open({ blob: sharedParents });
    expect(view.listDirectory({ relativePath: `shared/${parents}` })).toHaveLength(800);
  });

  it('bounds indexed path text even when there are few archive entries', async () => {
    const parents = Array.from({ length: 254 }, () => 'p'.repeat(200)).join('/');
    const blob = await createZipBlob({
      files: Object.fromEntries(Array.from({ length: 3 }, (_, index) => [`branch-${index}/${parents}/note.txt`, 'small'])),
    });
    await expect(ZipArchiveView.open({ blob })).rejects.toThrow('paths are too large to index safely');
  });

  it('closes every source after indexing, completed reads, and cancelled reads', async () => {
    const blob = await createZipBlob({ files: { 'note.txt': 'stream content' } });
    const closed: Array<ReturnType<typeof vi.fn>> = [];
    const view = await ZipArchiveView.openSource({
      createSource: async () => {
        const source = createBlobZipSource({ blob });
        const close = vi.fn(async () => source.close());
        closed.push(close);
        return { ...source, close };
      },
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toHaveBeenCalledOnce();
    expect(await (await view.readFileBlob({ relativePath: 'note.txt' })).text()).toBe('stream content');
    expect(closed).toHaveLength(2);
    expect(closed[1]).toHaveBeenCalledOnce();
    await (await view.openFileStream({ relativePath: 'note.txt' })).cancel();
    expect(closed).toHaveLength(3);
    expect(closed[2]).toHaveBeenCalledOnce();
  });

  it('closes sources when indexing or opening an entry fails', async () => {
    const blob = await createZipBlob({ files: { 'note.txt': 'content' } });
    const closed: Array<ReturnType<typeof vi.fn>> = [];
    let failRead = false;
    const createSource = async () => {
      const source = createBlobZipSource({ blob });
      const close = vi.fn(async () => source.close());
      closed.push(close);
      return {
        ...source,
        close,
        read: async ({ offset, length }: { offset: number, length: number }) => {
          if (failRead) {
            throw new Error('source read failed');
          }
          return source.read({ offset, length });
        },
      };
    };
    const view = await ZipArchiveView.openSource({ createSource });
    failRead = true;
    await expect(view.openFileStream({ relativePath: 'note.txt' })).rejects.toThrow('source read failed');
    expect(closed[1]).toHaveBeenCalledOnce();
    await expect(ZipArchiveView.openSource({ createSource })).rejects.toThrow('source read failed');
    expect(closed[2]).toHaveBeenCalledOnce();
  });
});
