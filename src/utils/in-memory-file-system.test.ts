import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from './in-memory-file-system';

describe('in-memory filesystem errors', () => {
  it('exposes missing entries as named and text-compatible NotFoundError values', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });

    const fileError = await root.getFileHandle('missing.txt').catch(error => error);
    expect(fileError).toBeInstanceOf(Error);
    expect(fileError).toMatchObject({ name: 'NotFoundError' });
    expect((fileError as Error).message).toContain('NotFoundError');

    await expect(root.getDirectoryHandle('missing')).rejects.toThrow('NotFoundError');
  });
});
