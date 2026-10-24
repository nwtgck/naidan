import { describe, expect, it, vi } from 'vitest';
import { validateLinkedModelDirectory } from './linked-directory-input';

function directory({ children }: { children: [string, FileSystemHandle][] }): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    async *entries() {
      yield* children;
    },
  } as FileSystemDirectoryHandle;
}

function file(): FileSystemFileHandle {
  return { kind: 'file' } as FileSystemFileHandle;
}

describe('linked-root structural boundary', () => {
  it('accepts an empty download root and leaves repository contents untouched', async () => {
    await expect(validateLinkedModelDirectory({ directory: directory({ children: [] }), signal: undefined })).resolves.toBeUndefined();
    const repository = directory({ children: [] });
    const entries = vi.spyOn(repository, 'entries').mockImplementation(() => {
      throw new Error('Do not inspect repository internals');
    });
    const owner = directory({ children: [['repository', repository]] });
    const root = directory({ children: [['owner', owner], ['README.md', file()]] });
    await expect(validateLinkedModelDirectory({ directory: root, signal: undefined })).resolves.toBeUndefined();
    expect(entries).not.toHaveBeenCalled();
  });

  it('rejects choosing a model folder or owner folder instead of their common parent', async () => {
    const model = directory({ children: [['model.gguf', file()]] });
    const owner = directory({ children: [['repository', model]] });
    await expect(validateLinkedModelDirectory({ directory: model, signal: undefined })).rejects.toThrow('unsupported-input');
    await expect(validateLinkedModelDirectory({ directory: owner, signal: undefined })).rejects.toThrow('unsupported-input');
  });

  it('honors an already cancelled drop before enumerating any directory', async () => {
    const root = directory({ children: [] });
    const entries = vi.spyOn(root, 'entries');
    const controller = new AbortController();
    controller.abort();
    await expect(validateLinkedModelDirectory({ directory: root, signal: controller.signal })).rejects.toThrow();
    expect(entries).not.toHaveBeenCalled();
  });
});
