import { beforeEach, expect, it, vi } from 'vitest';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { llamaCppBrowserModelFiles } from '@/features/llama-cpp-browser/model-files';
import { listModelInventory } from './model-inventory';

vi.mock('@/features/llama-cpp-browser/model-files', () => ({ llamaCppBrowserModelFiles: { listModelEntries: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

it('shares an inventory scan while allowing either visible consumer to leave independently', async () => {
  const read = Promise.withResolvers<LocalModel[]>();
  vi.mocked(llamaCppBrowserModelFiles.listModelEntries).mockReturnValue(read.promise);
  const settings = new AbortController();
  const drawer = new AbortController();
  const first = listModelInventory({ signal: settings.signal });
  const second = listModelInventory({ signal: drawer.signal });
  const cancelled = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  expect(llamaCppBrowserModelFiles.listModelEntries).toHaveBeenCalledOnce();
  drawer.abort();
  await cancelled;
  const sharedSignal = vi.mocked(llamaCppBrowserModelFiles.listModelEntries).mock.calls[0]![0].signal;
  expect(sharedSignal?.aborted).toBe(false);
  const models = [{ modelId: 'user/model', size: 16, importedAt: 1 }];
  read.resolve(models);
  await expect(first).resolves.toEqual(models);
});

it('queues a replacement until the last cancelled filesystem read settles', async () => {
  const stale = Promise.withResolvers<LocalModel[]>();
  vi.mocked(llamaCppBrowserModelFiles.listModelEntries).mockReturnValueOnce(stale.promise).mockResolvedValueOnce([]);
  const controller = new AbortController();
  const first = listModelInventory({ signal: controller.signal });
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  const sharedSignal = vi.mocked(llamaCppBrowserModelFiles.listModelEntries).mock.calls[0]![0].signal;
  controller.abort();
  await rejected;
  expect(sharedSignal?.aborted).toBe(true);
  const replacement = listModelInventory({ signal: new AbortController().signal });
  await Promise.resolve();
  expect(llamaCppBrowserModelFiles.listModelEntries).toHaveBeenCalledOnce();
  stale.resolve([]);
  await expect(replacement).resolves.toEqual([]);
  expect(llamaCppBrowserModelFiles.listModelEntries).toHaveBeenCalledTimes(2);
});
