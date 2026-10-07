// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { existingUserModelDirectory } from './model-directory';

afterEach(() => vi.unstubAllGlobals());
it('never asks to create either model directory', async () => {
  const user = {}, models = { getDirectoryHandle: vi.fn(async () => user) };
  const root = { getDirectoryHandle: vi.fn(async () => models) };
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  expect(await existingUserModelDirectory()).toBe(user);
  expect(root.getDirectoryHandle.mock.calls).toEqual([['models']]);
  expect(models.getDirectoryHandle.mock.calls).toEqual([['user']]);
});
it('represents a missing directory without creating one', async () => {
  const lookup = vi.fn(async () => {
    throw new DOMException('missing', 'NotFoundError');
  });
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => ({ getDirectoryHandle: lookup }) } });
  expect(await existingUserModelDirectory()).toBeUndefined();
  expect(lookup).toHaveBeenCalledTimes(1);
});
it('does not hide storage failures as an empty model tree', async () => {
  vi.stubGlobal('navigator', {
    storage: {
    getDirectory: async () => {
    throw new DOMException('denied', 'SecurityError');
  },
  },
  });
  await expect(existingUserModelDirectory()).rejects.toMatchObject({ name: 'SecurityError' });
});
