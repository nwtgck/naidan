// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { directoryForGgufFile, droppedModelFiles, modelDirectoryFromFiles, validateLinkedModelRoot } from './model-directory-input';
import { directoryForModelFile } from '@/features/llama-cpp-browser/runtime/model-directory-input';
import { imageDirectoryForFile } from '@/features/stable-diffusion-cpp-browser/logic/repository-input';

function fileEntry({ name, file }: { name: string, file: File }): FileSystemFileEntry {
  return { name, isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(file) } as FileSystemFileEntry;
}

function folderEntry({ name, batches }: { name: string, batches: FileSystemEntry[][] }): FileSystemDirectoryEntry {
  let index = 0;
  return { name, isDirectory: true, isFile: false, createReader: () => ({ readEntries: (resolve: (entries: FileSystemEntry[]) => void) => resolve(batches[index++] ?? []) }) } as FileSystemDirectoryEntry;
}

function directory({ children }: { children: [string, FileSystemHandle][] }): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    async *entries() {
      yield* children;
    },
  } as FileSystemDirectoryHandle;
}

it('captures drag entries synchronously and preserves the chosen root plus every model format across all batches', async () => {
  const weight = new File(['weight'], 'model.gguf'), image = new File(['image'], 'vae.safetensors'), metadata = new File(['{}'], 'model.safetensors.index.json');
  const nested = folderEntry({ name: 'dir2', batches: [[fileEntry({ name: weight.name, file: weight })], [fileEntry({ name: image.name, file: image }), fileEntry({ name: metadata.name, file: metadata })]] });
  const ignored = folderEntry({ name: '.git', batches: [[fileEntry({ name: 'object', file: new File(['git'], 'object') })]] });
  const root = folderEntry({ name: 'dir1', batches: [[nested, ignored]] });
  let protectedStore = false;
  const getEntry = vi.fn(() => {
    if (protectedStore) {
      throw new Error('drag data protected');
    }
    return root;
  });
  const transfer = {
    items: [{ kind: 'file', webkitGetAsEntry: getEntry }],
    get files() {
      if (protectedStore) {
        throw new Error('drag data protected');
      }
      return [];
    },
  } as unknown as DataTransfer;
  const pending = droppedModelFiles({ transfer, signal: undefined });
  protectedStore = true;
  const result = await pending;
  expect(result.directories[0]).toEqual({ name: 'dir1', files: [{ path: 'dir2/model.gguf', file: weight }, { path: 'dir2/vae.safetensors', file: image }, { path: 'dir2/model.safetensors.index.json', file: metadata }] });
  expect(result.directories[0]!.files.map(file => `${result.directories[0]!.name}/${file.path}`)).toContain('dir1/dir2/model.gguf');
  expect(getEntry).toHaveBeenCalledOnce();
});

it('preserves loose files but refuses partial entry enumeration instead of flattening a directory', async () => {
  const file = new File(['model'], 'model.safetensors');
  const transfer = { items: [], files: [file] } as unknown as DataTransfer;
  expect(await droppedModelFiles({ transfer, signal: undefined })).toEqual({ files: [file], directories: [] });
  const entry = fileEntry({ name: file.name, file });
  await expect(droppedModelFiles({ transfer: { items: [{ kind: 'file', webkitGetAsEntry: () => entry }, { kind: 'file', webkitGetAsEntry: () => null }], files: [file] } as unknown as DataTransfer, signal: undefined })).rejects.toThrow('entire dropped directory');
});

it('rejects mixed picker roots and retains literal percent names without path decoding', () => {
  const a = new File(['a'], 'a.gguf'), b = new File(['b'], 'b.safetensors');
  Object.defineProperty(a, 'webkitRelativePath', { value: 'root/sub/%ZZ.gguf' });
  Object.defineProperty(b, 'webkitRelativePath', { value: 'other/b.safetensors' });
  expect(modelDirectoryFromFiles({ files: [a] })).toEqual({ name: 'root', files: [{ path: 'sub/%ZZ.gguf', file: a }] });
  expect(() => modelDirectoryFromFiles({ files: [a, b] })).toThrow('different roots');
});

it('uses exactly the same GGUF wrapper directory for text and image imports', () => {
  const file = new File(['model'], 'Example-Q4_K_M.GGUF');
  const expected = { name: 'Example-Q4_K_M-GGUF', files: [{ path: file.name, file }] };
  expect(directoryForGgufFile({ file })).toEqual(expected);
  expect(directoryForModelFile({ file })).toEqual(expected);
  expect(imageDirectoryForFile({ file })).toEqual(expected);
});

it.each(['model.gguf', 'model.safetensors', 'model.sft'])('requires owner/repository depth for linked %s weights but does not inspect repository contents', async name => {
  const file = { kind: 'file' } as FileSystemFileHandle;
  const repository = directory({ children: [[name, file]] });
  const owner = directory({ children: [['repository', repository]] });
  await expect(validateLinkedModelRoot({ directory: repository, signal: undefined })).rejects.toThrow('parent folder');
  await expect(validateLinkedModelRoot({ directory: owner, signal: undefined })).rejects.toThrow('parent folder');
  const entries = vi.spyOn(repository, 'entries').mockImplementation(() => {
    throw new Error('must not enumerate repository contents');
  });
  await expect(validateLinkedModelRoot({ directory: directory({ children: [['owner', owner], ['README.md', file]] }), signal: undefined })).resolves.toBeUndefined();
  expect(entries).not.toHaveBeenCalled();
});

it('allows empty linked download roots and stops already cancelled collection', async () => {
  await expect(validateLinkedModelRoot({ directory: directory({ children: [] }), signal: undefined })).resolves.toBeUndefined();
  const controller = new AbortController();
  controller.abort();
  const entry = folderEntry({ name: 'root', batches: [] });
  const reader = vi.spyOn(entry, 'createReader');
  await expect(droppedModelFiles({ transfer: { items: [{ kind: 'file', webkitGetAsEntry: () => entry }], files: [] } as unknown as DataTransfer, signal: controller.signal })).rejects.toThrow();
  expect(reader).not.toHaveBeenCalled();
});
