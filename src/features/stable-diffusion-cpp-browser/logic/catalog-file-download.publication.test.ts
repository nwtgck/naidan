// @vitest-environment node
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { MemoryDirectory, MemoryFile } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { saveImageCatalogFile } from './catalog-file-download';
import type { ImageDownloadDestination } from './catalog-download';
import type { CatalogFetch } from '@/features/stable-diffusion-cpp-browser/download-worker/fetch-types';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe.each(['opfs', 'host'] as const)('first %s pending marker failure', kind => {
  it.each(['open', 'write', 'close'] as const)('permits an explicit retry after a temporary %s failure before any payload is acquired', async phase => {
    const root = new MemoryDirectory('root');
    const directoryId = 'linked-models';
    const destination: ImageDownloadDestination = kind === 'opfs' ? { kind } : { kind, directoryId };
    vi.mocked(hostModelHandles.get).mockResolvedValue(root as unknown as HostModelDirectoryHandle);
    vi.stubGlobal('navigator', {
      storage: { getDirectory: async () => root },
      locks: {
      request: async (_name: string, _options: unknown, run: () => Promise<void>) => run(),
    },
    });
    const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
    view.setUint32(0, 0x46554747, true); view.setUint32(4, 3, true);
    const file = { repository: 'org/model', revision: 'a'.repeat(40), path: 'model.gguf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const fetch = vi.fn<CatalogFetch>(async () => ({
      url: '',
      status: 200,
      statusText: '',
      ok: true,
      redirected: false,
      responseType: 'basic',
      policyName: 'huggingface_models',
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
        controller.enqueue(bytes); controller.close();
      },
      }),
    }));
    const original = MemoryFile.prototype.createWritable;
    let failFirstPending = true;
    vi.spyOn(MemoryFile.prototype, 'createWritable').mockImplementation(async function (this: MemoryFile, options) {
      if (this.name === '.model.gguf.pending' && failFirstPending) {
        failFirstPending = false;
        const failure = new DOMException('Storage is full', 'QuotaExceededError');
        if (phase === 'open') throw failure;
        const writer = await original.call(this, options);
        if (phase === 'write') return {
          ...writer,
          write: async () => {
          throw failure;
        },
        };
        return {
          ...writer,
          close: async () => {
          throw failure;
        },
        };
      }
      return original.call(this, options);
    });
    const run = () => saveImageCatalogFile({ file, destination, signal: new AbortController().signal, report() {}, fetch });
    await expect(run()).rejects.toThrow('Storage is full');
    let folder = root;
    for (const part of kind === 'opfs' ? ['models', 'huggingface.co', 'org', 'model', 'resolve', 'main'] : ['org', 'model']) folder = await folder.getDirectoryHandle(part);
    expect(folder.children.has('model.gguf')).toBe(false);
    expect(folder.children.has('.model.gguf.pending')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();

    await run();
    expect((await folder.getFileHandle('model.gguf')).data).toEqual(bytes);
    expect(folder.children.has('.model.gguf.pending')).toBe(false);
    expect(folder.children.has('.model.gguf.complete')).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    if (kind === 'host') expect(hostModelHandles.get).toHaveBeenCalledWith({ id: toHostModelDirectoryId({ raw: directoryId }) });
  });
});
