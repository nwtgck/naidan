// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { unregisterHostModelDirectory } from './host-model-directories';
import { hostModelHandles } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { delete: vi.fn() } }));
const id = toHostModelDirectoryId({ raw: 'root-1' });
beforeEach(() => {
  vi.mocked(hostModelHandles.delete).mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { locks: { request: async (_key: string, run: () => Promise<void>) => run() } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('does not delete the handle when saving removal fails', async () => {
  const restore = vi.fn();
  await expect(unregisterHostModelDirectory({
    id,
    save: async () => {
      throw new Error('Settings save failed');
    },
    restore,
  })).rejects.toThrow('Settings save failed');
  expect(hostModelHandles.delete).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
});

it('restores just the removed registration when handle cleanup fails', async () => {
  const order: string[] = [];
  vi.mocked(hostModelHandles.delete).mockImplementation(async () => {
    order.push('delete'); throw new Error('IDB unavailable');
  });
  await expect(unregisterHostModelDirectory({
    id,
    save: async () => {
      order.push('save');
    },
    restore: async () => {
      order.push('restore');
    },
  })).rejects.toThrow('registration was restored');
  expect(order).toEqual(['save', 'delete', 'restore']);
});

it('reports partial removal explicitly if both cleanup and restoration fail', async () => {
  vi.mocked(hostModelHandles.delete).mockRejectedValue(new Error('IDB unavailable'));
  await expect(unregisterHostModelDirectory({
    id,
    save: async () => {},
    restore: async () => {
      throw new Error('Settings unavailable');
    },
  })).rejects.toThrow('registration could not be restored');
});
