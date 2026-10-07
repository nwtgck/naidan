// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { MemoryDirectory, MemoryFile } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { listHostImageRepositories, listImageRepositories } from './repository-store';
import { saveImageCatalogFile } from './catalog-file-download';
import type { CatalogFetch } from '@/features/stable-diffusion-cpp-browser/download-worker/fetch-types';
import type { ImageFileIdentity } from './catalog-source';
import { openModelDownloadAccess } from './model-download-access';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));
let root: MemoryDirectory, opfs: MemoryDirectory;
const bytes = new Uint8Array(32);
new DataView(bytes.buffer).setUint32(0, 0x46554747, true);
new DataView(bytes.buffer).setUint32(4, 3, true);
const file: ImageFileIdentity = {
  repository: 'owner/repo',
  revision: 'a'.repeat(40),
  path: 'nested/model.gguf',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const destination = { kind: 'host' as const, directoryId: 'root-1' };

async function directory(): Promise<MemoryDirectory> {
  let folder = root;
  for (const name of ['owner', 'repo', 'nested']) folder = await folder.getDirectoryHandle(name, { create: true });
  return folder;
}
const fetch = vi.fn<CatalogFetch>();
function serve({ offset }: { offset: number }): void {
  fetch.mockResolvedValue({
    url: '',
    statusText: '',
    responseType: 'basic',
    policyName: 'huggingface_models',
    redirected: false,
    ok: true,
    status: offset ? 206 : 200,
    headers: new Headers(offset ? { 'Content-Range': `bytes ${offset}-31/32` } : {}),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(offset)); controller.close();
      },
    }),
  });
}
beforeEach(() => {
  root = new MemoryDirectory('models'); opfs = new MemoryDirectory('opfs');
  vi.mocked(hostModelHandles.get).mockReset().mockResolvedValue(root as unknown as HostModelDirectoryHandle);
  fetch.mockReset(); serve({ offset: 0 });
  vi.stubGlobal('navigator', {
    storage: { getDirectory: async () => opfs },
    locks: {
      request: async (_name: string, options: { signal?: AbortSignal }, run: () => Promise<void>) => {
        options.signal?.throwIfAborted(); await run();
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('host image model storage', () => {
  it('reads markerless user files directly under owner/repository and never creates receipts', async () => {
    const folder = await directory(), handle = await folder.getFileHandle('model.gguf', { create: true }); handle.data = bytes;
    const before = [...folder.children.keys()];
    const repositories = await listHostImageRepositories({ directories: [{ id: 'root-1', name: 'models' }, { id: 'root-2', name: 'models' }], signal: undefined });
    expect(repositories.map(repo => repo.id)).toEqual(['host/root-1/owner/repo', 'host/root-2/owner/repo']);
    expect(repositories[0]?.files.map(entry => entry.path)).toEqual(['nested/model.gguf']);
    expect(repositories[0]?.hostSource).toEqual({ directoryId: 'root-1', directoryName: 'models', repository: 'owner/repo' });
    expect([...folder.children.keys()]).toEqual(before);
    expect(root.children.has('huggingface.co')).toBe(false);
  });

  it('hides known pending host files while leaving unrelated files readable', async () => {
    const folder = await directory();
    for (const name of ['model.gguf', 'other.gguf', '.model.gguf.pending']) (await folder.getFileHandle(name, { create: true })).data = bytes;
    const result = await listHostImageRepositories({ directories: [{ id: 'root-1', name: 'models' }], signal: undefined });
    expect(result[0]?.files.map(entry => entry.path)).toEqual(['nested/other.gguf']);
    expect(result[0]?.issues).toEqual([{ path: 'nested/model.gguf', message: 'Download is incomplete. Resume the catalog download.' }]);
  });

  it('keeps missing handles and IDB errors visible rather than treating the registry as empty', async () => {
    vi.mocked(hostModelHandles.get).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('IDB unavailable'));
    const result = await listHostImageRepositories({ directories: [{ id: 'missing', name: 'first' }, { id: 'broken', name: 'second' }], signal: undefined });
    expect(result.map(repo => repo.issues?.[0]?.message)).toEqual(['Reconnect this model directory', 'IDB unavailable']);
  });

  it('keeps OPFS remote files hidden without their completion receipt', async () => {
    let folder = opfs;
    for (const name of ['models', 'huggingface.co', 'owner', 'repo', 'resolve', 'main']) folder = await folder.getDirectoryHandle(name, { create: true });
    (await folder.getFileHandle('model.gguf', { create: true })).data = bytes;
    const result = await listImageRepositories({ signal: undefined });
    expect(result[0]?.files).toEqual([]);
    expect(result[0]?.issues?.[0]?.message).toContain('No valid completion receipt');
  });

  it('streams a download with native writable calls and publishes only after close', async () => {
    const folder = await directory();
    vi.spyOn(MemoryFile.prototype, 'createSyncAccessHandle').mockRejectedValue(new Error('OPFS-only API'));
    await saveImageCatalogFile({ file, destination, fetch, signal: new AbortController().signal, report() {} });
    const saved = await folder.getFileHandle('model.gguf');
    expect(saved.data).toEqual(bytes);
    expect(folder.children.has('.model.gguf.pending')).toBe(false);
    expect(folder.children.has('.model.gguf.complete')).toBe(true);
    expect(hostModelHandles.get).toHaveBeenCalledWith({ id: toHostModelDirectoryId({ raw: 'root-1' }) });
    expect(opfs.children.size).toBe(0);
  });

  it('commits a graceful pause and resumes from that durable byte position with Range', async () => {
    const controller = new AbortController();
    fetch.mockResolvedValueOnce({
      url: '',
      statusText: '',
      responseType: 'basic',
      policyName: 'huggingface_models',
      redirected: false,
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        start(stream) {
          stream.enqueue(bytes.slice(0, 16)); stream.enqueue(bytes.slice(16)); stream.close();
        },
      }),
    });
    await expect(saveImageCatalogFile({
      file,
      destination,
      fetch,
      signal: controller.signal,
      report({ progress }) {
        if (progress.phase === 'transferring' && progress.bytes === 16) controller.abort();
      },
    })).rejects.toThrow();
    const folder = await directory();
    expect((await folder.getFileHandle('model.gguf')).data).toEqual(bytes.slice(0, 16));
    const journal = JSON.parse(await (await (await folder.getFileHandle('.model.gguf.pending')).getFile()).text());
    expect(journal.bytes).toBe(16);
    expect(folder.children.has('.model.gguf.complete')).toBe(false);
    serve({ offset: 16 });
    await saveImageCatalogFile({ file, destination, fetch, signal: new AbortController().signal, report() {} });
    expect(fetch.mock.lastCall?.[0].request.headers).toEqual([['Range', 'bytes=16-']]);
    expect((await folder.getFileHandle('model.gguf')).data).toEqual(bytes);
    expect(folder.children.has('.model.gguf.pending')).toBe(false);
  });

  it('does not truncate a conflicting user file or create ownership markers for it', async () => {
    const folder = await directory(), handle = await folder.getFileHandle('model.gguf', { create: true });
    handle.data = new Uint8Array([1, 2, 3]);
    await expect(saveImageCatalogFile({ file, destination, fetch, signal: new AbortController().signal, report() {} })).rejects.toThrow('preserved without overwrite');
    expect(handle.data).toEqual(new Uint8Array([1, 2, 3]));
    expect([...folder.children.keys()]).toEqual(['model.gguf']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps failed native close attempts failed so a later cleanup cannot advance a journal', async () => {
    const stored = await (await directory()).getFileHandle('model.gguf', { create: true });
    const writer = await stored.createWritable();
    const failure = new Error('Disk close failed');
    vi.spyOn(writer, 'close').mockRejectedValue(failure);
    vi.spyOn(stored, 'createWritable').mockResolvedValue(writer);
    const access = await openModelDownloadAccess({ handle: stored as unknown as FileSystemFileHandle, kind: 'host', offset: 0 });
    await access.write({ bytes, at: 0 });
    await expect(access.flush()).rejects.toBe(failure);
    await expect(access.flush()).rejects.toBe(failure);
    await expect(access.close()).rejects.toBe(failure);
    expect(stored.data).toHaveLength(0);
  });
});
