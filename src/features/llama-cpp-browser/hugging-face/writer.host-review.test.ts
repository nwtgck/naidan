// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { MemoryDirectory, MemoryFile } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { listHostImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
import { prepareModelRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
import { createDownloadWriter } from './writer';
import { deleteRepository, listHuggingFaceModels, readJournal, repositoryDirectories } from './storage';
import { ggufBytes } from './test-opfs';
import type { DownloadSelection } from './types';

vi.mock('@/utils/worker-transport', () => ({ releaseWorkerRemote: vi.fn() }));
vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));

let root: MemoryDirectory;
const opfs = vi.fn();
const destination = { kind: 'host' as const, directoryId: 'root-a' };
const selection: DownloadSelection = { repository: 'owner/repo', revision: 'a'.repeat(40), files: [{ path: 'nested/model.gguf', size: 128 }] };

beforeEach(() => {
  root = new MemoryDirectory('same root name');
  vi.mocked(hostModelHandles.get).mockReset().mockResolvedValue(root as unknown as HostModelDirectoryHandle);
  opfs.mockReset().mockRejectedValue(new Error('Host download must never open OPFS'));
  vi.spyOn(MemoryFile.prototype, 'createSyncAccessHandle').mockRejectedValue(new Error('Host handles cannot use OPFS sync access'));
  vi.stubGlobal('navigator', {
    storage: { getDirectory: opfs },
    locks: {
      request: async (_name: string, optionsOrCallback: object | (() => Promise<unknown>), callback?: (lock: object) => Promise<unknown>) => callback ? callback({}) : typeof optionsOrCallback === 'function' ? optionsOrCallback() : undefined,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function folder(): Promise<MemoryDirectory> {
  return (await root.getDirectoryHandle('owner')).getDirectoryHandle('repo');
}
async function payload(): Promise<MemoryFile> {
  return (await (await folder()).getDirectoryHandle('nested')).getFileHandle('model.gguf');
}
async function imageFiles(): Promise<string[]> {
  const repositories = await listHostImageRepositories({ directories: [{ id: destination.directoryId, name: root.name }], signal: undefined });
  return repositories.flatMap(repository => repository.files.map(file => file.path));
}
async function completeFile({ writer, index, start }: { writer: ReturnType<typeof createDownloadWriter>, index: number, start: number }): Promise<void> {
  await writer.open({ fileIndex: index, start });
  await writer.append({ bytes: ggufBytes().slice(start) });
  await writer.finishFile();
}

describe('independent direct-host download publication', () => {
  it('commits a paused prefix and resumes directly while both readers hide incomplete bytes', async () => {
    let writer = createDownloadWriter();
    await writer.begin({ selection, destination });
    await writer.open({ fileIndex: 0, start: 0 });
    await writer.append({ bytes: ggufBytes().slice(0, 48) });
    expect((await payload()).data).toHaveLength(0);
    await writer.pause();

    expect((await payload()).data).toEqual(ggufBytes().slice(0, 48));
    expect((await readJournal({ folder: await folder() as unknown as FileSystemDirectoryHandle })).bytes).toEqual([48]);
    expect(await listHuggingFaceModels({ destination })).toEqual([]);
    expect(await imageFiles()).toEqual([]);

    writer = createDownloadWriter();
    expect(await writer.begin({ selection, destination })).toMatchObject({ status: 'ready', journal: { bytes: [48] } });
    await completeFile({ writer, index: 0, start: 48 });
    await writer.finish();
    expect((await payload()).data).toEqual(ggufBytes());
    expect((await listHuggingFaceModels({ destination })).map(model => model.id)).toEqual(['host/root-a/owner/repo:nested%2Fmodel.gguf']);
    expect(await imageFiles()).toEqual(['nested/model.gguf']);
    expect(opfs).not.toHaveBeenCalled();
  });

  it('keeps all shards and the projector hidden until the complete selection is published', async () => {
    const split = {
      ...selection,
      files: [
        { path: 'nested/model-00001-of-00002.gguf', size: 128 },
        { path: 'nested/model-00002-of-00002.gguf', size: 128 },
        { path: 'mmproj-F16.gguf', size: 128 },
      ],
    };
    const writer = createDownloadWriter();
    await writer.begin({ selection: split, destination });
    for (let index = 0; index < split.files.length; index++) {
      await completeFile({ writer, index, start: 0 });
      expect(await listHuggingFaceModels({ destination })).toEqual([]);
      expect(await imageFiles()).toEqual([]);
    }
    await writer.finish();

    const models = await repositoryDirectories({ repository: split.repository, destination });
    expect(models).toHaveLength(1);
    expect(models[0]?.modelPath).toBe(split.files[0]?.path);
    expect(models[0]?.projectorPath).toBe('mmproj-F16.gguf');
    expect(models[0]?.files.every(file => file.storageKind === 'host')).toBe(true);
    expect(await imageFiles()).toEqual(expect.arrayContaining(split.files.map(file => file.path)));
    expect(opfs).not.toHaveBeenCalled();
  });

  it('does not truncate pre-existing payloads on a duplicate download request', async () => {
    const repository = await (await root.getDirectoryHandle('owner', { create: true })).getDirectoryHandle('repo', { create: true });
    const nested = await repository.getDirectoryHandle('nested', { create: true });
    const model = await nested.getFileHandle('model.gguf', { create: true });
    model.data = ggufBytes();
    model.data[80] = 99;
    const before = model.data.slice();

    expect(await createDownloadWriter().begin({ selection, destination })).toEqual({ status: 'conflict', reason: 'existing-files' });
    expect(model.data).toEqual(before);
    expect(repository.children.has('.llama-cpp-import-pending')).toBe(false);
  });

  it('does not remove unrelated empty directories from a linked repository', async () => {
    const repository = await (await root.getDirectoryHandle('owner', { create: true })).getDirectoryHandle('repo', { create: true });
    const keep = await repository.getDirectoryHandle('keep-empty', { create: true });
    await keep.getDirectoryHandle('nested', { create: true });

    expect(await createDownloadWriter().begin({ selection, destination })).toMatchObject({ status: 'ready' });

    expect(await repository.getDirectoryHandle('keep-empty')).toBe(keep);
    expect(await keep.getDirectoryHandle('nested')).toBeDefined();
  });

  it('preserves a foreign publication marker and does not write its payload', async () => {
    const repository = await (await root.getDirectoryHandle('owner', { create: true })).getDirectoryHandle('repo', { create: true });
    const nested = await repository.getDirectoryHandle('nested', { create: true });
    const marker = await nested.getFileHandle('.model.gguf.pending', { create: true });
    marker.data = new TextEncoder().encode(JSON.stringify({ kind: 'another-application' }));
    const before = marker.data.slice();

    await expect(createDownloadWriter().begin({ selection, destination })).rejects.toThrow();
    expect(marker.data).toEqual(before);
    // A new journal would falsely authorize cancel/delete to remove a marker
    // belonging to another application, so conflict detection precedes it.
    expect(repository.children.has('.llama-cpp-import-pending')).toBe(false);
    expect(nested.children.has('model.gguf')).toBe(false);
    expect(opfs).not.toHaveBeenCalled();
  });

  it('retains hidden zero-byte state after close failure and allows an explicit retry', async () => {
    const writer = createDownloadWriter();
    await writer.begin({ selection, destination });
    const model = await payload();
    const original = model.createWritable.bind(model);
    const failClose = vi.spyOn(model, 'createWritable').mockImplementation(async options => {
      const writable = await original(options);
      return {
        ...writable,
        close: async () => {
          throw new DOMException('Cannot commit file', 'QuotaExceededError');
        },
      };
    });
    await writer.open({ fileIndex: 0, start: 0 });
    await writer.append({ bytes: ggufBytes() });
    await expect(writer.finishFile()).rejects.toThrow('Cannot commit file');
    await expect(writer.pause()).rejects.toThrow('Cannot commit file');
    expect(model.data).toHaveLength(0);
    expect(await imageFiles()).toEqual([]);
    expect(await listHuggingFaceModels({ destination })).toEqual([]);

    failClose.mockRestore();
    const retry = createDownloadWriter();
    expect(await retry.begin({ selection, destination })).toMatchObject({ status: 'ready', journal: { bytes: [0] } });
    await completeFile({ writer: retry, index: 0, start: 0 });
    await retry.finish();
    expect(model.data).toEqual(ggufBytes());
  });

  it('deletes only the reviewed partial download and keeps unrelated user data', async () => {
    const writer = createDownloadWriter();
    await writer.begin({ selection, destination });
    await writer.open({ fileIndex: 0, start: 0 });
    await writer.append({ bytes: ggufBytes().slice(0, 48) });
    await writer.pause();
    const repository = await folder();
    const unrelated = await repository.getFileHandle('notes.txt', { create: true });
    unrelated.data = new TextEncoder().encode('Keep this user file');
    const { plan } = await prepareModelRemoval({ id: 'host/root-a/owner/repo' });

    expect(plan.files.map(file => file.path)).not.toContain('notes.txt');
    expect(await deleteRepository({ repository: selection.repository, destination, plan })).toBe('deleted');
    expect(await (await repository.getFileHandle('notes.txt')).getFile().then(file => file.text())).toBe('Keep this user file');
    expect(await root.getDirectoryHandle('owner')).toBeDefined();
    expect(await imageFiles()).toEqual(['notes.txt']);
    expect(opfs).not.toHaveBeenCalled();
  });

  it('fails a revoked host grant before opening or creating any model paths', async () => {
    vi.spyOn(root, 'queryPermission').mockResolvedValue('denied');
    await expect(createDownloadWriter().begin({ selection, destination })).rejects.toThrow();
    expect(root.children.size).toBe(0);
    expect(opfs).not.toHaveBeenCalled();
  });
});
