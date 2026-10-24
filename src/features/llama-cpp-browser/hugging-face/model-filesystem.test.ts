// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { storageService } from '@/00-storage/service';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { listHostStoredModels, resolveHostModel } from '@/features/llama-cpp-browser/runtime/host-model-store';
import { prepareModelRemoval, removeStoredModel } from '@/features/llama-cpp-browser/runtime/model-store';
import { listHuggingFaceModels, resolveRepositoryModel } from './storage';
import { ggufBytes } from './test-opfs';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));

type FileTree = { [name: string]: Uint8Array | FileTree };

/** Create only directories and bytes; model discovery belongs to production code. */
async function writeTree({ folder, tree }: { folder: MemoryDirectory, tree: FileTree }): Promise<void> {
  for (const [name, entry] of Object.entries(tree)) {
    if (entry instanceof Uint8Array) {
      const writer = await (await folder.getFileHandle(name, { create: true })).createWritable();
      await writer.write(entry);
      await writer.close();
    } else {
      await writeTree({ folder: await folder.getDirectoryHandle(name, { create: true }), tree: entry });
    }
  }
}

async function directoryAt({ root, path }: { root: MemoryDirectory, path: string }): Promise<MemoryDirectory> {
  let folder = root;
  for (const name of path.split('/')) {
    folder = await folder.getDirectoryHandle(name);
  }
  return folder;
}

let opfs: MemoryDirectory, host: MemoryDirectory;

beforeEach(() => {
  opfs = new MemoryDirectory('opfs');
  host = new MemoryDirectory('Models');
  vi.mocked(hostModelHandles.get).mockReset().mockResolvedValue(host as unknown as HostModelDirectoryHandle);
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(['opfs', 'host'] as const)('%s directory tree to public IDs and selected files', kind => {
  it('keeps identical variants in different directories separate and confines a collision to its directory', async () => {
    const aliceModelFiles = {
      Q4_K_M: {
        'Model-Q4_K_M-00001-of-00002.gguf': ggufBytes(),
        'Model-Q4_K_M-00002-of-00002.gguf': ggufBytes(),
      },
      'Model-Q8_0.gguf': ggufBytes(),
    };
    const aliceOtherFiles = { 'Other-Q4_K_M.gguf': ggufBytes() };
    const bobModelFiles = { 'Model-Q4_K_M.gguf': ggufBytes() };

    // These are the actual physical directories, including OPFS's storage layout.
    const tree: FileTree = kind === 'opfs' ? {
      models: {
        'huggingface.co': {
          alice: {
            'Model-GGUF': { resolve: { main: aliceModelFiles } },
            'Other-GGUF': { resolve: { main: aliceOtherFiles } },
          },
          bob: {
            'Model-GGUF': { resolve: { main: bobModelFiles } },
          },
        },
      },
    } : {
      alice: {
        'Model-GGUF': aliceModelFiles,
        'Other-GGUF': aliceOtherFiles,
      },
      bob: {
        'Model-GGUF': bobModelFiles,
      },
    };
    const root = kind === 'opfs' ? opfs : host;
    await writeTree({ folder: root, tree });

    const directories = [{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'Models' }];
    const listModels = () => kind === 'opfs' ? listHuggingFaceModels() : listHostStoredModels({ directories, signal: undefined });
    const resolve = async ({ modelId }: { modelId: string }) => kind === 'opfs'
      ? resolveRepositoryModel({ modelId, signal: undefined }) : (await resolveHostModel({ modelId, directories, signal: undefined })).directory;
    const namespace = kind === 'opfs' ? 'hf.co' : 'host/Models';
    const physicalPrefix = kind === 'opfs' ? 'models/huggingface.co/' : '';
    const physicalSuffix = kind === 'opfs' ? '/resolve/main' : '';
    const expected = [
      {
        modelId: `${namespace}/alice/Model-GGUF:Q4_K_M`,
        directory: `${physicalPrefix}alice/Model-GGUF${physicalSuffix}`,
        files: ['Q4_K_M/Model-Q4_K_M-00001-of-00002.gguf', 'Q4_K_M/Model-Q4_K_M-00002-of-00002.gguf'],
      },
      {
        modelId: `${namespace}/alice/Model-GGUF:Q8_0`,
        directory: `${physicalPrefix}alice/Model-GGUF${physicalSuffix}`,
        files: ['Model-Q8_0.gguf'],
      },
      {
        modelId: `${namespace}/alice/Other-GGUF:Q4_K_M`,
        directory: `${physicalPrefix}alice/Other-GGUF${physicalSuffix}`,
        files: ['Other-Q4_K_M.gguf'],
      },
      {
        modelId: `${namespace}/bob/Model-GGUF:Q4_K_M`,
        directory: `${physicalPrefix}bob/Model-GGUF${physicalSuffix}`,
        files: ['Model-Q4_K_M.gguf'],
      },
    ];

    expect((await listModels()).map(model => model.modelId).sort()).toEqual(expected.map(model => model.modelId).sort());
    for (const model of expected) {
      const selected = await resolve({ modelId: model.modelId });
      expect(selected.primaryFile.relativePath).toBe(model.files[0]);
      expect(selected.files.map(file => file.relativePath)).toEqual(model.files);
      // Check the physical handles as well: matching filenames in another
      // owner's directory must never satisfy this selection.
      for (const file of selected.files) {
        const parts = `${model.directory}/${file.relativePath}`.split('/');
        const filename = parts.pop()!;
        const folder = await directoryAt({ root, path: parts.join('/') });
        if (!('handle' in file)) {
          throw new Error('A stored repository file must have a handle');
        }
        expect(file.handle).toBe(await folder.getFileHandle(filename));
      }
    }

    // Add a second Q4_K_M representation only under alice/Model-GGUF.
    const aliceModelDirectory = await directoryAt({ root, path: `${physicalPrefix}alice/Model-GGUF${physicalSuffix}` });
    await writeTree({ folder: aliceModelDirectory, tree: { Q4_K_M: { 'Model-Q4_K_M.gguf': ggufBytes() } } });
    const unchanged = expected.slice(1);
    expect((await listModels()).map(model => model.modelId).sort()).toEqual(unchanged.map(model => model.modelId).sort());
    await expect(resolve({ modelId: `${namespace}/alice/Model-GGUF:Q4_K_M` })).rejects.toThrow('unsupported-input');
    for (const model of unchanged) {
      expect((await resolve({ modelId: model.modelId })).files.map(file => file.relativePath)).toEqual(model.files);
    }
  });
});

describe('captured host removal plans', () => {
  it('keeps the reviewed folder when another registration takes over its public alias', async () => {
    const other = new MemoryDirectory('Other');
    const tree = { owner: { repo: { 'model.gguf': ggufBytes() } } };
    await writeTree({ folder: host, tree });
    await writeTree({ folder: other, tree });
    const originalId = toHostModelDirectoryId({ raw: 'original' });
    const otherId = toHostModelDirectoryId({ raw: 'other' });
    vi.mocked(hostModelHandles.get).mockImplementation(async ({ id }) => (id === originalId ? host : other) as unknown as HostModelDirectoryHandle);
    const loadDirectories = vi.spyOn(storageService, 'loadHostModelDirectories').mockResolvedValue([
      { id: originalId, name: 'Models' },
      { id: otherId, name: 'Other' },
    ]);
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: {
        request: async (_name: string, optionsOrCallback: object | (() => Promise<unknown>), callback?: (lock: object) => Promise<unknown>) => callback ? callback({}) : typeof optionsOrCallback === 'function' ? optionsOrCallback() : undefined,
      },
    });
    const modelId = 'host/Models/owner/repo:model';
    const { plan } = await prepareModelRemoval({ modelId, signal: undefined });
    const originalFolder = await directoryAt({ root: host, path: 'owner/repo' });
    expect(plan.folder).toBe(originalFolder);
    loadDirectories.mockClear().mockResolvedValue([
      { id: originalId, name: 'Renamed' },
      { id: otherId, name: 'Models' },
    ]);
    vi.mocked(hostModelHandles.get).mockClear();

    expect(await removeStoredModel({ plan })).toBe('deleted');
    expect(originalFolder.children.size).toBe(0);
    expect(await (await directoryAt({ root: other, path: 'owner/repo' })).getFileHandle('model.gguf')).toBeDefined();
    expect(loadDirectories).not.toHaveBeenCalled();
    expect(hostModelHandles.get).not.toHaveBeenCalled();
  });
});
