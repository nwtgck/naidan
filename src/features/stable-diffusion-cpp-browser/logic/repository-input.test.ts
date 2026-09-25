// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { imageDirectoriesFromDrop, imageDirectoryFromFiles } from './repository-input';
function localFile({ path }: { path: string }): File {
  const file = new File(['data'], path.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: path }); return file;
}
it('keeps a repository working tree, including metadata and tokenizer files, but not Git objects', () => {
  const input = imageDirectoryFromFiles({ files: ['repo/README.md', 'repo/vae/ae.safetensors', 'repo/config.json', 'repo/tokenizer/vocab.json', 'repo/.git/objects/aa'].map(path => localFile({ path })) });
  expect(input.name).toBe('repo');
  expect(input.files.map(file => file.path)).toEqual(['README.md', 'vae/ae.safetensors', 'config.json', 'tokenizer/vocab.json']);
  expect(() => imageDirectoryFromFiles({ files: [localFile({ path: 'a/file' }), localFile({ path: 'b/file' })] })).toThrow('different roots');
});
it('captures directory entries synchronously and reads every readEntries batch', async () => {
  const file = localFile({ path: 'repo/weights/model.gguf' });
  const leaf = { name: file.name, isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(file) } as unknown as FileSystemEntry;
  const batches = [[leaf], [leaf], []];
  const readEntries = vi.fn((resolve: (entries: FileSystemEntry[]) => void) => resolve(batches.shift()!));
  const folder = { name: 'repo', isDirectory: true, isFile: false, createReader: () => ({ readEntries }) };
  const get = vi.fn(() => folder);
  const transfer = { items: [{ kind: 'file', webkitGetAsEntry: get }], files: [] } as unknown as DataTransfer;
  const pending = imageDirectoriesFromDrop({ transfer, signal: undefined });
  expect(get).toHaveBeenCalledTimes(1);
  const entries = await pending; expect(readEntries).toHaveBeenCalledTimes(3); expect(entries[0]!.files).toHaveLength(2);
});
it('preserves roots in FileList fallback and rejects partial/opaque directory drops', async () => {
  const transfer = { items: [], files: [localFile({ path: 'A/a.gguf' }), localFile({ path: 'B/b.gguf' })] } as unknown as DataTransfer;
  expect((await imageDirectoriesFromDrop({ transfer, signal: undefined })).map(input => input.name)).toEqual(['A', 'B']);
  await expect(imageDirectoriesFromDrop({ transfer: { items: [], files: [new File(['x'], 'folder')] } as unknown as DataTransfer, signal: undefined })).rejects.toThrow('repository folder');
});
it('cancels traversal before a delayed entry batch can become a stored repository', async () => {
  const controller = new AbortController();
  let finish: ((entries: FileSystemEntry[]) => void) | undefined;
  const folder = { name: 'repo', isDirectory: true, isFile: false, createReader: () => ({ readEntries: (callback: (entries: FileSystemEntry[]) => void) => {
    finish = callback;
  } }) };
  const transfer = { items: [{ kind: 'file', webkitGetAsEntry: () => folder }], files: [] } as unknown as DataTransfer;
  const pending = imageDirectoriesFromDrop({ transfer, signal: controller.signal }); controller.abort(); finish?.([]);
  await expect(pending).rejects.toThrow();
});
