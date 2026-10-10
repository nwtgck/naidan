import { generateInputSchema } from '@/features/llama-cpp-browser/types';
// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import { MemoryDirectory, MemoryFile } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { listHostImageRepositories } from '@/features/stable-diffusion-cpp-browser/logic/repository-store';
import { createDownloadWriter } from './writer';
import { listHuggingFaceModels, listPendingDownloads, repositoryFolder, selectedFile, readJournal, installedSelection } from './storage';
import { listHostStoredModels, getHostModelInventoryIssues } from '@/features/llama-cpp-browser/runtime/host-model-store';
import { storedModelDirectory, prepareModelRemoval, removeStoredModel } from '@/features/llama-cpp-browser/runtime/model-store';
import type { DownloadSelection } from './types';
vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));
vi.mock('@/utils/worker-transport', () => ({ releaseWorkerRemote: vi.fn() }));
const destination = { kind: 'host' as const, directoryId: 'root-one' };
const selection: DownloadSelection = { repository: 'owner/repository', revision: 'a'.repeat(40), files: [{ path: 'nested/model.gguf', size: 128 }] };
let root: MemoryDirectory, opfs: MemoryDirectory;

function bytes(): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(128); value.set([71, 71, 85, 70, 3, 0, 0, 0]); return value;
}

beforeEach(() => {
  root = new MemoryDirectory('models'); opfs = new MemoryDirectory('opfs');
  vi.mocked(hostModelHandles.get).mockReset().mockResolvedValue(root as unknown as HostModelDirectoryHandle);
  vi.stubGlobal('navigator', {
    storage: { getDirectory: vi.fn(async () => opfs) },
    locks: {
      request: async (_name: string, optionsOrCallback: object | (() => Promise<unknown>), callback?: (lock: object) => Promise<unknown>) => callback ? callback({}) : typeof optionsOrCallback === 'function' ? optionsOrCallback() : undefined,
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function finish({ writer, index }: { writer: ReturnType<typeof createDownloadWriter>, index: number }): Promise<void> {
  await writer.open({ fileIndex: index, start: 0 }); await writer.append({ bytes: bytes() }); await writer.finishFile();
}

describe('direct linked-folder model storage', () => {
  it('downloads directly to root/owner/repository/subdirectories and resolves the same native handles', async () => {
    const sync = vi.spyOn(MemoryFile.prototype, 'createSyncAccessHandle').mockRejectedValue(new Error('OPFS only'));
    const writer = createDownloadWriter(); await writer.begin({ selection, destination }); await finish({ writer, index: 0 }); await writer.finish();
    expect(sync).not.toHaveBeenCalled(); expect(navigator.storage.getDirectory).not.toHaveBeenCalled(); expect(opfs.children.size).toBe(0);
    const folder = await root.getDirectoryHandle('owner').then(owner => owner.getDirectoryHandle('repository'));
    const saved = await folder.getDirectoryHandle('nested').then(nested => nested.getFileHandle('model.gguf')); expect(saved.data).toEqual(bytes());
    const models = await listHostStoredModels({ directories: [{ id: toHostModelDirectoryId({ raw: destination.directoryId }), name: 'models' }], signal: undefined });
    expect(models).toHaveLength(1); expect(models[0]?.name).toBe('host/root-one/owner/repository:nested%2Fmodel.gguf');
    expect(models[0]?.source).toMatchObject({ directoryName: 'models', path: 'nested/model.gguf' });
    const loaded = await storedModelDirectory({ name: models[0]!.name }); expect(loaded.files[0]?.handle).toBe(saved); expect(loaded.files[0]?.storageKind).toBe('host');
    expect((await installedSelection({ selection, destination }))?.id).toBe(models[0]?.id);
  });

  it('keeps deep linked paths and ordinary variants together without shortening routable names', async () => {
    const path = `${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(100)}.gguf`;
    const folder = await repositoryFolder({ repository: selection.repository, create: true, destination });
    for (const modelPath of [path, 'model-Q4_K_M.gguf']) {
      const file = await selectedFile({ folder, path: modelPath, create: true });
      const writable = await file.createWritable(); await writable.write(bytes()); await writable.close();
    }
    const models = await listHostStoredModels({ directories: [{ id: toHostModelDirectoryId({ raw: destination.directoryId }), name: 'models' }], signal: undefined });
    expect(models).toHaveLength(2);
    const deep = models.find(model => model.source?.path === path)!;
    expect(deep.name.length).toBeGreaterThan(512); expect(deep.name.length).toBeLessThanOrEqual(1024);
    expect(deep.name).toBe(deep.id);
    expect(generateInputSchema.shape.model.parse(deep.name)).toBe(deep.name);
    expect((await storedModelDirectory({ name: deep.name })).modelPath).toBe(path);
    expect(getHostModelInventoryIssues()).toEqual([]);
  });

  it('keeps partial files hidden from LM and image generation, then resumes committed bytes', async () => {
    let writer = createDownloadWriter(); await writer.begin({ selection, destination }); await writer.open({ fileIndex: 0, start: 0 });
    await writer.append({ bytes: bytes().slice(0, 48) }); await writer.pause();
    expect(await listHuggingFaceModels({ destination })).toEqual([]);
    expect((await listHostImageRepositories({ directories: [{ id: destination.directoryId, name: root.name }], signal: undefined }))[0]?.files).toEqual([]);
    expect((await listPendingDownloads({ destination }))[0]?.bytes).toEqual([48]);
    writer = createDownloadWriter(); expect(await writer.begin({ selection, destination })).toMatchObject({ status: 'ready', journal: { bytes: [48] } });
    await writer.open({ fileIndex: 0, start: 48 }); await writer.append({ bytes: bytes().slice(48) }); await writer.finishFile(); await writer.finish();
    expect(await listHuggingFaceModels({ destination })).toHaveLength(1); expect(await listPendingDownloads({ destination })).toEqual([]);
  });

  it('hides every shard and the projector until the selected complete set is verified', async () => {
    const split = { ...selection, files: [{ path: 'weights/model-00001-of-00002.gguf', size: 128 }, { path: 'weights/model-00002-of-00002.gguf', size: 128 }, { path: 'mmproj-F16.gguf', size: 128 }] };
    const writer = createDownloadWriter(); await writer.begin({ selection: split, destination }); await finish({ writer, index: 0 });
    expect(await listHuggingFaceModels({ destination })).toEqual([]);
    expect((await listHostImageRepositories({ directories: [{ id: destination.directoryId, name: root.name }], signal: undefined }))[0]?.files).toEqual([]);
    await finish({ writer, index: 1 }); await finish({ writer, index: 2 }); await writer.finish();
    const model = (await listHuggingFaceModels({ destination }))[0]!; const loaded = await storedModelDirectory({ name: model.name });
    expect(loaded.files).toHaveLength(3); expect(loaded.projectorPath).toBe('mmproj-F16.gguf');
  });

  it('fails revoked permission without creating or reading OPFS', async () => {
    vi.spyOn(root, 'queryPermission').mockResolvedValue('prompt');
    await expect(createDownloadWriter().begin({ selection, destination })).rejects.toThrow('permission expired');
    expect(navigator.storage.getDirectory).not.toHaveBeenCalled(); expect(root.children.size).toBe(0);
  });

  it('preserves another root with the same filename and reports unavailable registered roots', async () => {
    const writer = createDownloadWriter(); await writer.begin({ selection, destination }); await finish({ writer, index: 0 }); await writer.finish();
    vi.mocked(hostModelHandles.get).mockImplementation(async ({ id }) => idToRaw({ id }) === 'missing' ? undefined : root as unknown as HostModelDirectoryHandle);
    const models = await listHostStoredModels({ directories: ['root-one', 'missing', 'root-two'].map(raw => ({ id: toHostModelDirectoryId({ raw }), name: 'models' })), signal: undefined });
    expect(models.map(model => model.id)).toEqual(['host/root-one/owner/repository:nested%2Fmodel.gguf', 'host/root-two/owner/repository:nested%2Fmodel.gguf']);
    expect(getHostModelInventoryIssues()).toMatchObject([{ directoryId: 'missing', directoryName: 'models' }]);
  });

  it('deletes only an explicitly reviewed interrupted download and preserves unrelated user files', async () => {
    const writer = createDownloadWriter(); await writer.begin({ selection, destination }); await writer.open({ fileIndex: 0, start: 0 }); await writer.append({ bytes: bytes().slice(0, 48) }); await writer.pause();
    const folder = await repositoryFolder({ repository: selection.repository, create: false, destination });
    const keep = await folder.getFileHandle('notes.txt', { create: true }); const writable = await keep.createWritable(); await writable.write('keep'); await writable.close();
    const { plan } = await prepareModelRemoval({ id: 'host/root-one/owner/repository' });
    expect(plan.files.map(file => file.path)).toContain('nested/.model.gguf.pending');
    expect(await removeStoredModel({ plan })).toBe('deleted'); expect(await (await keep.getFile()).text()).toBe('keep');
    expect(await listPendingDownloads({ destination })).toEqual([]);
  });

  it('retains pending markers and the last durable journal when native close fails', async () => {
    const writer = createDownloadWriter(); await writer.begin({ selection, destination });
    const folder = await repositoryFolder({ repository: selection.repository, create: false, destination });
    const handle = await selectedFile({ folder, path: selection.files[0]!.path, create: false });
    const original = handle.createWritable.bind(handle);
    vi.spyOn(handle, 'createWritable').mockImplementation(async options => {
      const stream = await original(options); return {
        ...stream,
        close: async () => {
          throw new Error('Disk unavailable');
        },
      };
    });
    await writer.open({ fileIndex: 0, start: 0 }); await writer.append({ bytes: bytes() }); await expect(writer.finishFile()).rejects.toThrow('Disk unavailable');
    expect((await readJournal({ folder })).bytes).toEqual([0]); expect(await listHuggingFaceModels({ destination })).toEqual([]);
  });
});
