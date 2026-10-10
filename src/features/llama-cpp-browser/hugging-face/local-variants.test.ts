// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage';
import { hostModelReference, hostModelSelector, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination-types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { resolveHostModelName } from '@/features/llama-cpp-browser/runtime/host-model-aliases';
import { resolveHostModel, selectHostModel, listHostStoredModels } from '@/features/llama-cpp-browser/runtime/host-model-store';
import { prepareModelRemoval } from '@/features/llama-cpp-browser/runtime/model-store';
import { repositoryDirectories, repositoryFolder, resolveRepositoryModel, selectedFile } from './storage';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));
vi.mock('@/utils/worker-transport', () => ({ releaseWorkerRemote: vi.fn() }));
const repository = 'LiquidAI/LFM2.5-230M-GGUF';
const prefix = 'LFM2.5-230M-';
let root: MemoryDirectory;

beforeEach(() => {
  root = new MemoryDirectory('models');
  vi.mocked(hostModelHandles.get).mockResolvedValue(root as unknown as HostModelDirectoryHandle);
  const opfs = new MemoryDirectory('opfs');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs }, locks: { request: async (_name: string, optionsOrOperation: object | (() => Promise<unknown>), operation?: (lock: object) => Promise<unknown>) => typeof optionsOrOperation === 'function' ? optionsOrOperation() : operation!({}) } });
});

afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function writeFiles({ paths, destination }: { paths: string[], destination: ModelDestination }) {
  const folder = await repositoryFolder({ repository, create: true, destination });
  for (const path of paths) {
    const writer = await (await selectedFile({ folder, path, create: true })).createWritable();
    const bytes = new Uint8Array(128); bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
    await writer.write(bytes); await writer.close();
  }
  return folder;
}

describe.each(['opfs', 'host'] as const)('%s shared local variants', kind => {
  const destination: ModelDestination = kind === 'host' ? { kind, directoryId: 'root' } : { kind };
  const name = ({ selector }: { selector: string }) => kind === 'host'
    ? hostModelSelector({ directoryId: 'root', repository, selector })
    : `hf.co/${repository}:${selector}`;
  const resolve = ({ selector }: { selector: string }) => kind === 'host'
    ? selectHostModel({ name: name({ selector }) }) : resolveRepositoryModel({ name: name({ selector }) });

  it.each([
    { path: `${prefix}Q4_K_M.gguf`, variant: 'Q4_K_M' },
    { path: `${prefix}model.bin.gguf`, variant: 'model.bin' },
    { path: `nested/${prefix}KQuant-17GB-Q4_K_M.gguf`, variant: 'nested/KQuant-17GB-Q4_K_M' },
    { path: `nested/${prefix}custom:100%-Q4.gguf`, variant: 'nested/custom:100%-Q4' },
    { path: `literal%2F/${prefix}Q4.gguf`, variant: 'literal%2F/Q4' },
    { path: '.gguf', variant: '.gguf' },
    { path: '..gguf', variant: '..gguf' },
    { path: '...gguf', variant: '...gguf' },
    { path: `${prefix}.gguf`, variant: `${prefix}.gguf` },
  ])('lists and resolves $variant with exact-file compatibility', async ({ path, variant }) => {
    await writeFiles({ paths: [path], destination });
    const models = await repositoryDirectories({ repository, destination });
    expect(models).toHaveLength(1); expect(models[0]?.name).toBe(name({ selector: variant }));
    expect((await resolve({ selector: variant })).modelPath).toBe(path);
    const canonical = models[0]!.id;
    expect((await (kind === 'host' ? selectHostModel({ name: canonical }) : resolveRepositoryModel({ name: canonical }))).modelPath).toBe(path);
  });

  it('distinguishes split, unsplit and an unsplit file resembling the grouping key', async () => {
    const split = `${prefix}Q4_K_M-00001-of-00002.gguf`;
    await writeFiles({ paths: [split, `${prefix}Q4_K_M-00002-of-00002.gguf`], destination });
    const before = await resolve({ selector: 'Q4_K_M (split-00002)' });
    await writeFiles({ paths: [`${prefix}Q4_K_M.gguf`, `${prefix}Q4_K_M-of-00002.gguf`], destination });
    expect(await repositoryDirectories({ repository, destination })).toHaveLength(3);
    expect((await resolve({ selector: 'Q4_K_M (split-00002)' })).id).toBe(before.id);
    expect((await resolve({ selector: 'Q4_K_M' })).modelPath).toBe(`${prefix}Q4_K_M.gguf`);
  });

  it.each(['Q4_K_M', 'custom:100%', 'nested/Q4'])('rejects exact path versus variant collision for %s', async selector => {
    const path = `${selector}.gguf`;
    const parts = path.split('/'); const leaf = parts.pop()!;
    const collision = [...parts, `${prefix}${leaf}.gguf`].join('/');
    await writeFiles({ paths: [path, collision], destination });
    await expect(resolve({ selector: path })).rejects.toThrow('unsupported-input');
    const encodedName = kind === 'host' ? hostModelReference({ directoryId: 'root', repository, modelPath: path }) : `hf.co/${repository}:${encodeURIComponent(path)}`;
    await expect(kind === 'host' ? selectHostModel({ name: encodedName }) : resolveRepositoryModel({ name: encodedName })).rejects.toThrow('unsupported-input');
  });

  it('never selects a non-GGUF file or an absent filename-like variant', async () => {
    const folder = await writeFiles({ paths: ['model.bin'], destination });
    const file = await selectedFile({ folder, path: 'model.bin', create: false });
    const read = vi.spyOn(file, 'getFile');
    expect(await repositoryDirectories({ repository, destination })).toEqual([]);
    await expect(resolve({ selector: 'model.bin' })).rejects.toThrow('missing-model');
    await expect(resolve({ selector: 'missing.bin' })).rejects.toThrow('missing-model');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects duplicate variant labels and missing selections', async () => {
    await writeFiles({ paths: [`${prefix}Q4.gguf`, 'Q4.gguf'], destination });
    await expect(resolve({ selector: 'Q4' })).rejects.toThrow('unsupported-input');
    await expect(resolve({ selector: 'Q8' })).rejects.toThrow('missing-model');
  });
});

it('requires the captured GGUF identity at the Host runtime boundary', async () => {
  const destination = { kind: 'host' as const, directoryId: 'root' };
  const path = `${prefix}model.bin.gguf`;
  await writeFiles({ paths: [path], destination });
  const name = hostModelSelector({ directoryId: 'root', repository, selector: 'model.bin' });
  const selected = await selectHostModel({ name });
  expect(selected.modelPath).toBe(path);
  expect((await resolveHostModel({ name: selected.id })).modelPath).toBe(path);
  await expect(resolveHostModel({ name })).rejects.toThrow();
  await expect(prepareModelRemoval({ id: name })).rejects.toThrow();
});

it('never reinterprets a captured Host file identity as a replacement variant at runtime or deletion', async () => {
  const destination = { kind: 'host' as const, directoryId: 'root' };
  const path = `${prefix}Q4.gguf`;
  const folder = await writeFiles({ paths: [path], destination });
  const accepted = await selectHostModel({ name: hostModelSelector({ directoryId: 'root', repository, selector: 'Q4' }) });
  await folder.removeEntry(path);
  await writeFiles({ paths: [`${prefix}${path}.gguf`], destination });
  await expect(resolveHostModel({ name: accepted.id })).rejects.toThrow('missing-model');
  await expect(prepareModelRemoval({ id: accepted.id })).rejects.toThrow('missing-model');
});

it('publishes the registered folder alias and shared quantization label together', async () => {
  const destination = { kind: 'host' as const, directoryId: 'root' };
  const path = `${prefix}Q4_K_M.gguf`;
  await writeFiles({ paths: [path], destination });
  const directories = [{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'models-for-browser' }];
  const models = await listHostStoredModels({ directories, signal: undefined });
  expect(models[0]?.name).toBe('host/models-for-browser/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M');
  const selected = await selectHostModel({ name: resolveHostModelName({ name: models[0]!.name, directories }) });
  expect(selected.id).toBe(models[0]?.id); expect(selected.modelPath).toBe(path);
});
