// @vitest-environment node
import { executeDeletionPlan, scanDeletionTree } from '@/features/llama-cpp-browser/runtime/deletion-plan';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory, MemoryFile } from '@/utils/file-system-publication/memory.test-support';
import { withModelFileMarkers, modelPublicationDirectoryName, readModelFileReceipt, readModelFileRegistration, registerModelFileMove, writeModelMarkerJson } from './model-file-publication';

afterEach(() => vi.restoreAllMocks());

describe('failed model marker creation', () => {
  const name = '.model.gguf.pending';

  it.each(['open', 'write', 'close'] as const)('removes only its new unchanged empty file after %s fails', async phase => {
    const directory = new MemoryDirectory('models');
    const failure = new DOMException('Storage is full', 'QuotaExceededError');
    const original = MemoryFile.prototype.createWritable;
    vi.spyOn(MemoryFile.prototype, 'createWritable').mockImplementation(async function (this: MemoryFile, options) {
      if (phase === 'open') {
        throw failure;
      }
      const writer = await original.call(this, options);
      if (phase === 'write') {
        return {
          ...writer,
          write: async () => {
            throw failure;
          },
        };
      }
      return {
        ...writer,
        close: async () => {
          throw failure;
        },
      };
    });
    await expect(writeModelMarkerJson({ directory: directory as unknown as FileSystemDirectoryHandle, name, value: { bytes: 0 } })).rejects.toBe(failure);
    expect(directory.children.has(name)).toBe(false);
  });

  it.each([
    { markerName: name, contents: '' },
    { markerName: name, contents: '{broken' },
    { markerName: '.model.gguf.complete', contents: '{"existing":"receipt"}' },
  ])('preserves a pre-existing $markerName containing $contents when writing fails', async ({ markerName, contents }) => {
    const directory = new MemoryDirectory('models');
    const handle = await directory.getFileHandle(markerName, { create: true });
    handle.data = new TextEncoder().encode(contents);
    handle.failWrite = true;
    await expect(writeModelMarkerJson({ directory: directory as unknown as FileSystemDirectoryHandle, name: markerName, value: { bytes: 0 } })).rejects.toThrow('Quota exceeded');
    expect(directory.children.get(markerName)).toBe(handle);
    expect(await (await handle.getFile()).text()).toBe(contents);
  });

  it.each(['replaced', 'bytes-changed', 'timestamp-changed', 'unreadable', 'remove-failed'] as const)('preserves uncertain ownership after %s and retains the original failure', async change => {
    const directory = new MemoryDirectory('models');
    const failure = new DOMException('Initial writer failed', 'QuotaExceededError');
    const original = MemoryFile.prototype.createWritable;
    vi.spyOn(MemoryFile.prototype, 'createWritable').mockImplementation(async function (this: MemoryFile, options) {
      const writer = await original.call(this, options);
      return {
        ...writer,
        write: async () => {
          switch (change) {
          case 'replaced': directory.children.set(name, new MemoryFile(name));
            break;
          case 'bytes-changed': this.data = new TextEncoder().encode('foreign');
            break;
          case 'timestamp-changed': this.modified++;
            break;
          case 'unreadable': vi.spyOn(this, 'getFile').mockRejectedValue(new Error('Read denied'));
            break;
          case 'remove-failed': vi.spyOn(directory, 'removeEntry').mockRejectedValue(new Error('Removal denied'));
            break;
          default: {
            const exhaustive: never = change;
            throw new Error(String(exhaustive));
          }
          }
          throw failure;
        },
      };
    });
    await expect(writeModelMarkerJson({ directory: directory as unknown as FileSystemDirectoryHandle, name, value: { bytes: 0 } })).rejects.toBe(failure);
    expect(directory.children.has(name)).toBe(true);
    if (change === 'bytes-changed') {
      const file = await (await directory.getFileHandle(name)).getFile();
      expect(await file.text()).toBe('foreign');
    }
  });
});

describe('persistent move publication contracts', () => {
  it('does not infer completion from a registration while pending, nor from an unregistered final', async () => {
    const memory = new MemoryDirectory('files', { calls: [] });
    const directory = memory as unknown as FileSystemDirectoryHandle;
    const handle = await memory.getFileHandle('model.gguf', { create: true });
    const file = await handle.getFile();
    expect(await readModelFileReceipt({ directory, name: handle.name, file })).toBeUndefined();
    await registerModelFileMove({ directory, name: handle.name, source: { kind: 'local' }, replacement: 'reject' });
    await memory.getFileHandle('.model.gguf.pending', { create: true });
    await memory.getFileHandle('.model.gguf.complete', { create: true });
    expect(await readModelFileReceipt({ directory, name: handle.name, file })).toBeUndefined();
    await memory.removeEntry('.model.gguf.pending');
    expect(await readModelFileReceipt({ directory, name: handle.name, file })).toMatchObject({ version: 1, size: 0 });
    expect(memory.children.get(modelPublicationDirectoryName)?.kind).toBe('directory');
    expect(memory.children.has('.model.gguf.complete')).toBe(true);
  });

  it('preserves ownership metadata when an explicitly confirmed payload deletion fails', async () => {
    const memory = new MemoryDirectory('files', { calls: [] });
    const directory = memory as unknown as FileSystemDirectoryHandle;
    const name = 'model.gguf';
    await registerModelFileMove({ directory, name, source: { kind: 'local' }, replacement: 'reject' });
    await memory.getFileHandle(`${name}.tmp`, { create: true });
    await memory.getFileHandle(`.${name}.pending`, { create: true });
    await memory.getFileHandle(`.${name}.complete`, { create: true });
    const { files } = await scanDeletionTree({ folder: directory });
    const remove = memory.removeEntry.bind(memory);
    using failure = vi.spyOn(memory, 'removeEntry').mockImplementation(async (entry, options) => {
      if (entry === `${name}.tmp`) {
        expect(memory.children.has(`.${name}.pending`)).toBe(true);
        expect(memory.children.has(`.${name}.complete`)).toBe(true);
        expect(await readModelFileRegistration({ directory, name })).toEqual({ source: { kind: 'local' } });
        throw new DOMException('Busy', 'NoModificationAllowedError');
      }
      return remove(entry, options);
    });
    await expect(executeDeletionPlan({ folder: directory, files, selectedRelativePaths: files.map(file => file.relativePath) })).rejects.toThrow('Busy');
    expect(failure).toHaveBeenCalledOnce();
    expect(memory.children.has(`${name}.tmp`)).toBe(true);
    failure.mockRestore();
    expect(await executeDeletionPlan({ folder: directory, files, selectedRelativePaths: files.map(file => file.relativePath) })).toBe('deleted');
    expect(memory.children.size).toBe(0);
  });

  it('captures source metadata in the confirmed deletion without deleting another file source', async () => {
    const memory = new MemoryDirectory('files', { calls: [] });
    const directory = memory as unknown as FileSystemDirectoryHandle;
    for (const name of ['one.gguf', 'two.gguf']) {
      await registerModelFileMove({ directory, name, source: { kind: 'local' }, replacement: 'reject' });
      await memory.getFileHandle(name, { create: true });
    }
    const selectedRelativePaths = withModelFileMarkers({ paths: ['one.gguf'] });
    const files = (await scanDeletionTree({ folder: directory })).files.filter(file => selectedRelativePaths.includes(file.relativePath));
    expect(files.map(file => file.relativePath)).toContain(`${modelPublicationDirectoryName}/one.gguf`);
    expect(await executeDeletionPlan({ folder: directory, files, selectedRelativePaths })).toBe('deleted');
    expect(await readModelFileRegistration({ directory, name: 'one.gguf' })).toBeUndefined();
    expect(await readModelFileRegistration({ directory, name: 'two.gguf' })).toBeDefined();
    expect(memory.children.has('two.gguf')).toBe(true);
  });

  it('preserves bytes when source metadata changes after deletion confirmation', async () => {
    const memory = new MemoryDirectory('files', { calls: [] });
    const directory = memory as unknown as FileSystemDirectoryHandle;
    await registerModelFileMove({ directory, name: 'model.gguf', source: { kind: 'local' }, replacement: 'reject' });
    await memory.getFileHandle('model.gguf', { create: true });
    const selectedRelativePaths = withModelFileMarkers({ paths: ['model.gguf'] });
    const files = (await scanDeletionTree({ folder: directory })).files.filter(file => selectedRelativePaths.includes(file.relativePath));
    (await (await memory.getDirectoryHandle(modelPublicationDirectoryName)).getFileHandle('model.gguf')).modified++;
    expect(await executeDeletionPlan({ folder: directory, files, selectedRelativePaths })).toBe('changed');
    expect(memory.children.has('model.gguf')).toBe(true);
  });

  it('never changes existing pinned provenance unless the caller verified its final', async () => {
    const memory = new MemoryDirectory('files', { calls: [] });
    const directory = memory as unknown as FileSystemDirectoryHandle;
    const first = { kind: 'hugging-face' as const, repository: 'org/repo', revision: 'a'.repeat(40), path: 'model.gguf', sha256: 'c'.repeat(64) };
    const second = { ...first, revision: 'b'.repeat(40) };
    await registerModelFileMove({ directory, name: 'model.gguf', source: first, replacement: 'reject' });
    await expect(registerModelFileMove({ directory, name: 'model.gguf', source: second, replacement: 'reject' })).rejects.toThrow('source changed');
    expect(await readModelFileRegistration({ directory, name: 'model.gguf' })).toEqual({ source: first });
    await registerModelFileMove({ directory, name: 'model.gguf', source: second, replacement: 'verified-final' });
    expect(await readModelFileRegistration({ directory, name: 'model.gguf' })).toEqual({ source: second });
    const persisted = await (await (await memory.getDirectoryHandle(modelPublicationDirectoryName)).getFileHandle('model.gguf')).getFile();
    expect(JSON.parse(await persisted.text())).toEqual(second);
  });
});
