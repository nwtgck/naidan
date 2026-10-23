import { describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { createDownloadQueue } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import { DownloadConflictError, type DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';
import type { downloadRepository } from '@/features/llama-cpp-browser/hugging-face/download';
import { readModelLaunchReference } from '@/features/llama-cpp-browser/model-launch/reference';
import { resolveModelLaunchConfiguration, targetForChoice } from '@/features/llama-cpp-browser/model-launch/target';
const catalog: RepositoryCatalog = { repository: 'owner/Model', revision: 'b'.repeat(40), projectors: [], models: ['Q4_K_M', 'Q8_0'].map(q => ({ label: q, size: 256, files: [{ path: `nested/Model-${q}.gguf`, size: 256 }] })) };
const path = 'nested/Model-Q8_0.gguf';
const modelId = 'hf.co/owner/Model:nested/Q8_0';

// The former missing-model card rebuilt a download from the old modelId.
// Recovery now uses the shared explicit picker and queue. Keep the selection,
// pinned-revision and cancellation contracts at those production boundaries.
describe('explicit ordinary-chat recovery download', () => {
  it('downloads the selected files, never the first quantization', async () => {
    const target = targetForChoice({ catalog, path });
    expect(target.modelId).toBe(modelId);
    expect(target.mainFilePath).toBe(path);
    expect(target.selection.files).toEqual([{ path, size: 256 }]);
    const download = vi.fn<typeof downloadRepository>().mockResolvedValue(undefined);
    const queue = createDownloadQueue({ download });
    await flushPromises();
    expect(download).not.toHaveBeenCalled();
    const task = queue.enqueue({ key: modelId, repository: catalog.repository, source: 'repository', prepare: async () => target.selection });
    expect((await task.done).status).toBe('complete');
    expect(download).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ selection: target.selection }));
  });

  it('rejects ambiguous current file groups instead of picking the first matching modelId', async () => {
    const ambiguous = { ...catalog, models: [catalog.models[1]!, { ...catalog.models[1]!, files: [{ path: 'nested/Model_Q8_0.gguf', size: 256 }] }] };
    const download = vi.fn<typeof downloadRepository>();
    const queue = createDownloadQueue({ download });
    const task = queue.enqueue({ key: modelId, repository: catalog.repository, source: 'repository', prepare: async () => targetForChoice({ catalog: ambiguous, path }).selection });
    expect((await task.done).status).toBe('failed');
    expect(download).not.toHaveBeenCalled();
  });

  it('retains the explicitly captured revision when retrying an interrupted transfer', async () => {
    const target = targetForChoice({ catalog: { ...catalog, revision: 'a'.repeat(40) }, path });
    const download = vi.fn<typeof downloadRepository>().mockRejectedValueOnce(new Error('Interrupted')).mockResolvedValue(undefined);
    const queue = createDownloadQueue({ download });
    const prepare = vi.fn(async () => target.selection);
    const first = queue.enqueue({ key: modelId, repository: catalog.repository, source: 'repository', prepare });
    expect((await first.done).status).toBe('failed');
    const retry = queue.enqueue({ key: modelId, repository: catalog.repository, source: 'repository', prepare });
    expect((await retry.done).status).toBe('complete');
    expect(download).toHaveBeenCalledTimes(2);
    for (const [args] of download.mock.calls) {
      expect(args.selection).toEqual(target.selection);
      expect(args.selection.revision).not.toBe(catalog.revision);
    }
  });

  it.each(['user/model', 'hf.co/owner/Model:', 'hf.co/owner/Model', 'hf.co/owner/Model:../secret'])('does not guess a public source for %s', modelId => {
    expect(readModelLaunchReference({ modelId })).toBeUndefined();
  });

  it('surfaces a conflicting interrupted download and permission failures without applying success', async () => {
    const download = vi.fn<typeof downloadRepository>().mockRejectedValueOnce(new DownloadConflictError({ reason: 'different-download' })).mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    const queue = createDownloadQueue({ download });
    const target = targetForChoice({ catalog, path });
    const first = queue.enqueue({ key: modelId, repository: catalog.repository, source: 'repository', prepare: async () => target.selection });
    expect(await first.done).toMatchObject({ status: 'failed', error: 'different-download' });
    const retry = queue.enqueue({ key: modelId, repository: catalog.repository, source: 'repository', prepare: async () => target.selection });
    expect(await retry.done).toMatchObject({ status: 'failed', error: 'failed' });
  });

  it('rejects changed repositories and removed exact variants', async () => {
    expect(resolveModelLaunchConfiguration({ input: catalog.repository, requestedVariant: 'Q8_0', catalog: { ...catalog, repository: 'other/Model' }, multimodal: 'off' })).toMatchObject({ status: 'invalid', problem: 'invalid-input' });
    expect(() => targetForChoice({ catalog: { ...catalog, models: [catalog.models[0]!] }, path })).toThrow();
  });

  it('stops before writing files if cancelled while preparing the explicit selection', async () => {
    const gate = Promise.withResolvers<DownloadSelection>();
    using _completion = {
      [Symbol.dispose]() {
        gate.resolve(targetForChoice({ catalog, path }).selection);
      },
    };
    const download = vi.fn<typeof downloadRepository>();
    const queue = createDownloadQueue({ download });
    const prepare = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signal.throwIfAborted();
      return gate.promise;
    });
    const task = queue.enqueue({ key: modelId, repository: catalog.repository, source: 'repository', prepare });
    await flushPromises();
    expect(prepare).toHaveBeenCalledOnce();
    queue.cancel({ id: task.id });
    gate.resolve(targetForChoice({ catalog, path }).selection);
    expect((await task.done).status).toBe('cancelled');
    expect(download).not.toHaveBeenCalled();
  });
});
