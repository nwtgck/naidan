// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDirectory, MemoryFile } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { writeModelMarkerJson } from './model-file-publication';

afterEach(() => vi.restoreAllMocks());

describe('failed model marker creation', () => {
  const name = '.model.gguf.pending';

  it.each(['open', 'write', 'close'] as const)('removes only its new unchanged empty file after %s fails', async phase => {
    const directory = new MemoryDirectory('models');
    const failure = new DOMException('Storage is full', 'QuotaExceededError');
    const original = MemoryFile.prototype.createWritable;
    vi.spyOn(MemoryFile.prototype, 'createWritable').mockImplementation(async function (this: MemoryFile, options) {
      if (phase === 'open') throw failure;
      const writer = await original.call(this, options);
      if (phase === 'write') return { ...writer, write: async () => {
        throw failure;
      } };
      return { ...writer, close: async () => {
        throw failure;
      } };
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
      return { ...writer, write: async () => {
        switch (change) {
        case 'replaced': directory.children.set(name, new MemoryFile(name)); break;
        case 'bytes-changed': this.data = new TextEncoder().encode('foreign'); break;
        case 'timestamp-changed': this.modified++; break;
        case 'unreadable': vi.spyOn(this, 'getFile').mockRejectedValue(new Error('Read denied')); break;
        case 'remove-failed': vi.spyOn(directory, 'removeEntry').mockRejectedValue(new Error('Removal denied')); break;
        default: { const exhaustive: never = change; throw new Error(String(exhaustive)); }
        }
        throw failure;
      } };
    });
    await expect(writeModelMarkerJson({ directory: directory as unknown as FileSystemDirectoryHandle, name, value: { bytes: 0 } })).rejects.toBe(failure);
    expect(directory.children.has(name)).toBe(true);
    if (change === 'bytes-changed') {
      const file = await (await directory.getFileHandle(name)).getFile();
      expect(await file.text()).toBe('foreign');
    }
  });
});
