// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { resolveHostModelName } from '@/features/llama-cpp-browser/runtime/host-model-aliases';
import { listHostStoredModels, selectHostModel } from '@/features/llama-cpp-browser/runtime/host-model-store';
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

afterEach(() => vi.unstubAllGlobals());

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
    const resolve = ({ name }: { name: string }) => kind === 'opfs'
      ? resolveRepositoryModel({ name }) : selectHostModel({ name: resolveHostModelName({ name, directories }) });
    const namespace = kind === 'opfs' ? 'hf.co' : 'host/Models';
    const physicalPrefix = kind === 'opfs' ? 'models/huggingface.co/' : '';
    const physicalSuffix = kind === 'opfs' ? '/resolve/main' : '';
    const expected = [
      {
        name: `${namespace}/alice/Model-GGUF:Q4_K_M`,
        directory: `${physicalPrefix}alice/Model-GGUF${physicalSuffix}`,
        files: ['Q4_K_M/Model-Q4_K_M-00001-of-00002.gguf', 'Q4_K_M/Model-Q4_K_M-00002-of-00002.gguf'],
      },
      {
        name: `${namespace}/alice/Model-GGUF:Q8_0`,
        directory: `${physicalPrefix}alice/Model-GGUF${physicalSuffix}`,
        files: ['Model-Q8_0.gguf'],
      },
      {
        name: `${namespace}/alice/Other-GGUF:Q4_K_M`,
        directory: `${physicalPrefix}alice/Other-GGUF${physicalSuffix}`,
        files: ['Other-Q4_K_M.gguf'],
      },
      {
        name: `${namespace}/bob/Model-GGUF:Q4_K_M`,
        directory: `${physicalPrefix}bob/Model-GGUF${physicalSuffix}`,
        files: ['Model-Q4_K_M.gguf'],
      },
    ];

    expect((await listModels()).map(model => model.name).sort()).toEqual(expected.map(model => model.name).sort());
    for (const model of expected) {
      const selected = await resolve({ name: model.name });
      expect(selected.modelPath).toBe(model.files[0]);
      expect(selected.files.map(file => file.path)).toEqual(model.files);
      // Check the physical handles as well: matching filenames in another
      // owner's directory must never satisfy this selection.
      for (const file of selected.files) {
        const parts = `${model.directory}/${file.path}`.split('/');
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
    expect((await listModels()).map(model => model.name).sort()).toEqual(unchanged.map(model => model.name).sort());
    await expect(resolve({ name: `${namespace}/alice/Model-GGUF:Q4_K_M` })).rejects.toThrow('unsupported-input');
    for (const model of unchanged) {
      expect((await resolve({ name: model.name })).files.map(file => file.path)).toEqual(model.files);
    }
  });
});
