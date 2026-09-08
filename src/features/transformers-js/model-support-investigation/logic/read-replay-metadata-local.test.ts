import { describe, expect, it, vi } from 'vitest';
import { readReplayMetadataLocal } from '@/features/transformers-js/model-support-investigation/logic/read-replay-metadata-local';

describe('replay metadata local read capability', () => {
  it('uses exact revision and completion marker, without reading or writing bytes', async () => {
    const bytes = vi.fn();
    const file = new Blob(['{}']);
    Object.defineProperty(file, 'arrayBuffer', { value: bytes });
    const getFile = vi.fn(async () => file);
    const root = {
      getDirectoryHandle: vi.fn(async () => root),
      getFileHandle: vi.fn(async () => ({ getFile })),
    };
    const result = await readReplayMetadataLocal({ storageRoot: root as unknown as FileSystemDirectoryHandle, modelId: 'public/model', revision: 'a'.repeat(40), path: 'config.json' });
    expect(result).toBe(file);
    expect(root.getDirectoryHandle.mock.calls).toEqual(['models', 'huggingface.co', 'public', 'model', 'resolve', 'a'.repeat(40)].map(path => [path, { create: false }]));
    expect(root.getFileHandle.mock.calls).toEqual([['.config.json.complete', { create: false }], ['config.json', { create: false }]]);
    expect(bytes).not.toHaveBeenCalled();
  });

  it('distinguishes missing marker/file from non-NotFound I/O failure', async () => {
    const root = { getDirectoryHandle: vi.fn(async () => root), getFileHandle: vi.fn() };
    const args = { storageRoot: root as unknown as FileSystemDirectoryHandle, modelId: 'public/model', revision: 'a'.repeat(40), path: 'config.json' };
    root.getFileHandle.mockRejectedValueOnce(new DOMException('missing', 'NotFoundError'));
    expect(await readReplayMetadataLocal(args)).toBeUndefined();
    root.getFileHandle.mockRejectedValueOnce(new DOMException('unreadable', 'NotReadableError'));
    await expect(readReplayMetadataLocal(args)).rejects.toMatchObject({ name: 'NotReadableError' });
  });
});
