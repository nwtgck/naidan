import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from './in-memory-file-system';

describe('in-memory filesystem errors', () => {
  it('matches the observed Chrome DOMException contract for missing entries', async () => {
    const root = new MockFileSystemDirectoryHandle({ name: 'root' });

    const fileError = await root.getFileHandle('missing.txt').catch((error: unknown) => error);
    const directoryError = await root.getDirectoryHandle('missing').catch((error: unknown) => error);
    const expectedMessage = 'A requested file or directory could not be found at the time an operation was processed.';

    expect(fileError).toBeInstanceOf(DOMException);
    expect(fileError).toMatchObject({
      name: 'NotFoundError',
      message: expectedMessage,
      code: 8,
    });
    expect(String(fileError)).toBe(`NotFoundError: ${expectedMessage}`);
    expect(directoryError).toBeInstanceOf(DOMException);
    expect(directoryError).toMatchObject({
      name: 'NotFoundError',
      message: expectedMessage,
      code: 8,
    });
  });
});
