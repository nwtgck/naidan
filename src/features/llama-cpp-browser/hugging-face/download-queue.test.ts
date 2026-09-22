import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createDownloadQueue } from './download-queue';
import type { downloadRepository } from './download';
import { SuggestionPlanError } from './suggestion-plan';
import type { DownloadSelection } from './types';
const selection: DownloadSelection = { repository: 'owner/model', revision: 'a'.repeat(40), files: [{ path: 'model-Q4_K_M.gguf', size: 128 }] };
describe('page-lifetime sequential model download queue', () => {
  it('queues the entire intent, cancels unstarted work with no preparation and deduplicates repeated clicks', async () => {
    const gate = Promise.withResolvers<void>();
    const download = vi.fn<typeof downloadRepository>().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
    const queue = createDownloadQueue({ download });
    const prepare = vi.fn(async () => selection);
    const a = queue.enqueue({ key: 'a', repository: selection.repository, source: 'suggestion', prepare });
    const bPrepare = vi.fn(async () => ({ ...selection, repository: 'owner/second' }));
    const b = queue.enqueue({ key: 'b', repository: 'owner/second', source: 'repository', prepare: bPrepare });
    const cPrepare = vi.fn(async () => ({ ...selection, repository: 'owner/third' }));
    const c = queue.enqueue({ key: 'c', repository: 'owner/third', source: 'suggestion', prepare: cPrepare });
    expect(queue.enqueue({ key: 'a', repository: selection.repository, source: 'suggestion', prepare }).id).toBe(a.id);
    await flushPromises(); expect(download).toHaveBeenCalledOnce(); expect(bPrepare).not.toHaveBeenCalled(); expect(cPrepare).not.toHaveBeenCalled();
    expect(queue.position({ id: c.id })).toBe(2); queue.cancel({ id: b.id });
    expect(queue.position({ id: c.id })).toBe(1); expect((await b.done).status).toBe('cancelled');
    gate.resolve(); expect((await a.done).status).toBe('complete'); expect((await c.done).status).toBe('complete');
    expect(download).toHaveBeenCalledTimes(2); expect(bPrepare).not.toHaveBeenCalled();
    expect(queue.changed.value).toBe(2);
  });
  it('waits for abort cleanup before starting the next writer', async () => {
    const cleanup = Promise.withResolvers<void>();
    const download = vi.fn<typeof downloadRepository>().mockImplementationOnce(async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      await cleanup.promise; signal.throwIfAborted();
    }).mockResolvedValue(undefined);
    const queue = createDownloadQueue({ download });
    const first = queue.enqueue({ key: 'first', repository: selection.repository, source: 'repository', prepare: async () => selection });
    const second = queue.enqueue({ key: 'second', repository: selection.repository, source: 'suggestion', prepare: async () => selection });
    await flushPromises(); queue.cancel({ id: first.id }); await flushPromises();
    expect(download).toHaveBeenCalledOnce(); expect(queue.jobs.value[0]?.status).toBe('pausing');
    cleanup.resolve(); expect((await first.done).status).toBe('paused'); expect((await second.done).status).toBe('complete');
  });
  it('cancels metadata preparation without creating a resumable payload and continues after ambiguity', async () => {
    const gate = Promise.withResolvers<DownloadSelection>();
    const download = vi.fn<typeof downloadRepository>().mockResolvedValue(undefined);
    const queue = createDownloadQueue({ download });
    const first = queue.enqueue({ key: 'first', repository: selection.repository, source: 'suggestion', prepare: () => gate.promise });
    const second = queue.enqueue({ key: 'second', repository: selection.repository, source: 'suggestion', prepare: async () => {
      throw new SuggestionPlanError();
    } });
    await flushPromises(); queue.cancel({ id: first.id }); gate.resolve(selection);
    expect((await first.done).status).toBe('cancelled');
    expect(await second.done).toMatchObject({ status: 'failed', error: 'selection-unavailable' });
    expect(download).not.toHaveBeenCalled();
    const third = queue.enqueue({ key: 'third', repository: selection.repository, source: 'repository', prepare: async () => selection });
    expect((await third.done).status).toBe('complete');
  });
  it('preserves a committed success when a pause races the writer completion', async () => {
    const gate = Promise.withResolvers<void>();
    const queue = createDownloadQueue({ download: async () => gate.promise });
    const task = queue.enqueue({ key: 'test', repository: selection.repository, source: 'repository', prepare: async () => selection });
    await flushPromises(); queue.cancel({ id: task.id }); gate.resolve();
    expect((await task.done).status).toBe('complete');
    expect(createDownloadQueue({ download: async () => {} }).jobs.value).toEqual([]);
  });
});
