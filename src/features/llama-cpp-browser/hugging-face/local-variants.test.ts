// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import { hostModelReference, hostModelSelector, type ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination-types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { resolveHostModelName } from '@/features/llama-cpp-browser/runtime/host-model-aliases';
import { resolveHostModel, selectHostModel, listHostStoredModels } from '@/features/llama-cpp-browser/runtime/host-model-store';
import { prepareModelRemoval, storedModelDirectory } from '@/features/llama-cpp-browser/runtime/model-store';
import { resolveStoredModelName } from '@/features/llama-cpp-browser/host-model-names';
import { listHuggingFaceModels, repositoryDirectories, repositoryFolder, resolveRepositoryModel, selectedFile } from './storage';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));
vi.mock('@/00-storage/service', () => ({ storageService: { loadHostModelDirectories: vi.fn() } }));
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

async function writeFiles({ repository, paths, destination }: { repository: string, paths: string[], destination: ModelDestination }) {
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
  const directories = [{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'Models' }];
  const publicModels = () => kind === 'host' ? listHostStoredModels({ directories, signal: undefined }) : listHuggingFaceModels({ destination });
  const resolvePublic = ({ name }: { name: string }) => kind === 'host'
    ? selectHostModel({ name: resolveHostModelName({ name, directories }) }) : resolveRepositoryModel({ name });

  it.each([
    {
      layout: 'quantization directory with four shards', repository: 'unsloth/Model-GGUF',
      groups: [{ variant: 'UD-Q4_K_XL', paths: [
        'UD-Q4_K_XL/Model-UD-Q4_K_XL-00001-of-00004.gguf',
        'UD-Q4_K_XL/Model-UD-Q4_K_XL-00002-of-00004.gguf',
        'UD-Q4_K_XL/Model-UD-Q4_K_XL-00003-of-00004.gguf',
        'UD-Q4_K_XL/Model-UD-Q4_K_XL-00004-of-00004.gguf',
      ] }],
    },
    {
      layout: 'model and quantization repeated in the directory', repository: 'bartowski/Model-GGUF',
      groups: [{ variant: 'Q8_0', paths: ['Model-Q8_0/Model-Q8_0-00001-of-00002.gguf', 'Model-Q8_0/Model-Q8_0-00002-of-00002.gguf'] }],
    },
    {
      layout: 'lowercase root filenames with both single and split models', repository: 'Qwen/Model-GGUF',
      groups: [
        { variant: 'q2_k', paths: ['model-q2_k.gguf'] },
        { variant: 'q4_k_m', paths: ['model-q4_k_m-00001-of-00002.gguf', 'model-q4_k_m-00002-of-00002.gguf'] },
      ],
    },
    {
      layout: 'dot separator after a dotted model version', repository: 'TheBloke/Model-v0.2-GGUF',
      groups: [{ variant: 'Q4_K_M', paths: ['model-v0.2.Q4_K_M.gguf'] }],
    },
    {
      layout: 'meaningful ancestors above repeated quantization directories', repository: 'owner/Model-GGUF',
      groups: [
        { variant: 'imatrix/Q4_K_M', paths: ['imatrix/Q4_K_M/Model-Q4_K_M.gguf'] },
        { variant: 'plain/Q4_K_M', paths: ['plain/Q4_K_M/Model-Q4_K_M.gguf'] },
      ],
    },
    {
      layout: 'different model families in one repository', repository: 'owner/various-2bit-sota-gguf',
      groups: [
        { variant: 'llama-v2-13b-2.17bpw', paths: ['llama-v2-13b-2.17bpw.gguf'] },
        { variant: 'mistral-7b-2.20bpw', paths: ['mistral-7b-2.20bpw.gguf'] },
      ],
    },
    {
      layout: 'unknown modifiers and model sizes outside the repository prefix', repository: 'owner/Model-GGUF',
      groups: [
        { variant: 'i1-MXFP4', paths: ['Model-i1-MXFP4.gguf'] },
        { variant: '35B-FutureMethod-q4_Custom', paths: ['Model-35B-FutureMethod-q4_Custom.gguf'] },
      ],
    },
  ])('lists readable IDs and resolves every file in $layout', async ({ repository, groups }) => {
    await writeFiles({ repository, paths: groups.flatMap(group => group.paths), destination });
    const prefix = kind === 'host' ? `host/Models/${repository}` : `hf.co/${repository}`;
    const models = await publicModels();
    expect(models.map(model => model.name).sort()).toEqual(groups.map(group => `${prefix}:${group.variant}`).sort());
    for (const group of groups) {
      const selected = await resolvePublic({ name: `${prefix}:${group.variant}` });
      expect(selected.modelPath).toBe(group.paths[0]);
      expect(selected.files.map(file => file.path).sort()).toEqual([...group.paths].sort());
      expect(selected.id).toBe(models.find(model => model.name === `${prefix}:${group.variant}`)?.id);
    }
  });

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
    await writeFiles({ repository, paths: [path], destination });
    const models = await repositoryDirectories({ repository, destination });
    expect(models).toHaveLength(1); expect(models[0]?.name).toBe(name({ selector: variant }));
    expect((await resolve({ selector: variant })).modelPath).toBe(path);
    const listed = await publicModels();
    expect(listed).toHaveLength(1);
    expect((await resolvePublic({ name: listed[0]!.name })).modelPath).toBe(path);
    const canonical = models[0]!.id;
    expect((await (kind === 'host' ? selectHostModel({ name: canonical }) : resolveRepositoryModel({ name: canonical }))).modelPath).toBe(path);
  });

  it('hides both same-name split and unsplit groups, but keeps their exact paths selectable', async () => {
    const split = [`${prefix}Q4_K_M-00001-of-00002.gguf`, `${prefix}Q4_K_M-00002-of-00002.gguf`];
    const folder = await writeFiles({ repository, paths: split, destination });
    expect((await resolve({ selector: 'Q4_K_M' })).files.map(file => file.path)).toEqual(split);

    const unsplit = `${prefix}Q4_K_M.gguf`;
    await writeFiles({ repository, paths: [unsplit, `${prefix}Q4_K_M-of-00002.gguf`], destination });
    expect(await repositoryDirectories({ repository, destination })).toHaveLength(3);
    expect((await listHuggingFaceModels({ destination })).map(model => model.name)).toEqual([name({ selector: 'Q4_K_M-of-00002' })]);
    await expect(resolve({ selector: 'Q4_K_M' })).rejects.toThrow('unsupported-input');
    expect((await resolve({ selector: split[0]! })).files.map(file => file.path)).toEqual(split);
    expect((await resolve({ selector: unsplit })).files.map(file => file.path)).toEqual([unsplit]);
    await expect(resolve({ selector: 'Q4_K_M (split-00002)' })).rejects.toThrow('missing-model');

    await folder.removeEntry(unsplit);
    expect((await listHuggingFaceModels({ destination })).map(model => model.name)).toContain(name({ selector: 'Q4_K_M' }));
    expect((await resolve({ selector: 'Q4_K_M' })).files.map(file => file.path)).toEqual(split);
  });

  it.each(['Q4_K_M', 'custom:100%', 'nested/Q4'])('rejects exact path versus variant collision for %s', async selector => {
    const path = `${selector}.gguf`;
    const parts = path.split('/'); const leaf = parts.pop()!;
    const collision = [...parts, `${prefix}${leaf}.gguf`].join('/');
    await writeFiles({ repository, paths: [path, collision], destination });
    expect((await listHuggingFaceModels({ destination })).map(model => model.name)).not.toContain(name({ selector: path }));
    await expect(resolve({ selector: path })).rejects.toThrow('unsupported-input');
    const encodedName = kind === 'host' ? hostModelReference({ directoryId: 'root', repository, modelPath: path }) : `hf.co/${repository}:${encodeURIComponent(path)}`;
    await expect(kind === 'host' ? selectHostModel({ name: encodedName }) : resolveRepositoryModel({ name: encodedName })).rejects.toThrow('unsupported-input');
  });

  it('never selects a non-GGUF file or an absent filename-like variant', async () => {
    const folder = await writeFiles({ repository, paths: ['model.bin'], destination });
    const file = await selectedFile({ folder, path: 'model.bin', create: false });
    const read = vi.spyOn(file, 'getFile');
    expect(await repositoryDirectories({ repository, destination })).toEqual([]);
    await expect(resolve({ selector: 'model.bin' })).rejects.toThrow('missing-model');
    await expect(resolve({ selector: 'missing.bin' })).rejects.toThrow('missing-model');
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects duplicate variant labels and missing selections', async () => {
    await writeFiles({ repository, paths: [`${prefix}Q4.gguf`, 'Q4.gguf'], destination });
    expect(await listHuggingFaceModels({ destination })).toEqual([]);
    await expect(resolve({ selector: 'Q4' })).rejects.toThrow('unsupported-input');
    await expect(resolve({ selector: 'Q8' })).rejects.toThrow('missing-model');
  });

  it('hides both models when removing a repeated directory creates the same short name', async () => {
    const paths = [`${prefix}Q4.gguf`, `Q4/${prefix}Q4.gguf`];
    await writeFiles({ repository, paths, destination });
    expect(await publicModels()).toEqual([]);
    await expect(resolve({ selector: 'Q4' })).rejects.toThrow('unsupported-input');
    for (const path of paths) expect((await resolve({ selector: path })).modelPath).toBe(path);
  });

  it('omits incomplete split groups without hiding an unrelated complete model', async () => {
    await writeFiles({ repository, paths: [`${prefix}Q4-00001-of-00002.gguf`, `${prefix}Q8.gguf`], destination });
    expect((await publicModels()).map(model => model.name)).toEqual([kind === 'host' ? `host/Models/${repository}:Q8` : `hf.co/${repository}:Q8`]);
    await expect(resolve({ selector: 'Q4' })).rejects.toThrow('missing-model');
    expect((await resolve({ selector: 'Q8' })).files.map(file => file.path)).toEqual([`${prefix}Q8.gguf`]);
  });

  it('keeps raw percent, colon and Unicode selectors separate from internal encoded identities', async () => {
    const cases = [
      { variant: 'Q A', path: `${prefix}Q A.gguf` },
      { variant: 'Q%20A', path: `${prefix}Q%20A.gguf` },
      { variant: 'nested/custom:100%-日本語', path: `nested/${prefix}custom:100%-日本語.gguf` },
      { variant: 'literal%2F/Q4', path: `literal%2F/${prefix}Q4.gguf` },
    ];
    await writeFiles({ repository, paths: cases.map(entry => entry.path), destination });
    const publicPrefix = kind === 'host' ? `host/Models/${repository}` : `hf.co/${repository}`;
    // OPFS also accepts legacy encoded exact paths. Its encoded-looking alias
    // collides with the raw space alias and must not be advertised or preferred.
    const visible = cases.filter(entry => kind === 'host' || entry.variant !== 'Q%20A');
    expect((await publicModels()).map(model => model.name).sort()).toEqual(visible.map(entry => `${publicPrefix}:${entry.variant}`).sort());
    for (const { variant, path } of visible) {
      const selected = await resolvePublic({ name: `${publicPrefix}:${variant}` });
      expect(selected.modelPath).toBe(path);
    }
    if (kind === 'opfs') await expect(resolve({ selector: 'Q%20A' })).rejects.toThrow('unsupported-input');
  });
});

it('requires the captured GGUF identity at the Host runtime boundary', async () => {
  const destination = { kind: 'host' as const, directoryId: 'root' };
  const path = `${prefix}model.bin.gguf`;
  await writeFiles({ repository, paths: [path], destination });
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
  const folder = await writeFiles({ repository, paths: [path], destination });
  const accepted = await selectHostModel({ name: hostModelSelector({ directoryId: 'root', repository, selector: 'Q4' }) });
  await folder.removeEntry(path);
  await writeFiles({ repository, paths: [`${prefix}${path}.gguf`], destination });
  await expect(resolveHostModel({ name: accepted.id })).rejects.toThrow('missing-model');
  await expect(prepareModelRemoval({ id: accepted.id })).rejects.toThrow('missing-model');
});

it('never reinterprets a captured OPFS file identity as a replacement variant at runtime or deletion', async () => {
  const destination = { kind: 'opfs' as const };
  const path = `${prefix}Q4.gguf`;
  const folder = await writeFiles({ repository, paths: [path], destination });
  const accepted = await resolveStoredModelName({ name: `hf.co/${repository}:Q4` });
  expect(accepted).toBe(`hf.co/${repository}:${encodeURIComponent(path)}`);
  expect((await storedModelDirectory({ name: accepted })).modelPath).toBe(path);

  await folder.removeEntry(path);
  await writeFiles({ repository, paths: [`${prefix}${path}.gguf`], destination });
  await expect(storedModelDirectory({ name: accepted })).rejects.toThrow('missing-model');
  await expect(prepareModelRemoval({ id: accepted })).rejects.toThrow('missing-model');
});

it('keeps the captured OPFS file usable after its public short name becomes ambiguous', async () => {
  const destination = { kind: 'opfs' as const };
  const path = `${prefix}Q4.gguf`;
  await writeFiles({ repository, paths: [path], destination });
  const accepted = await resolveStoredModelName({ name: `hf.co/${repository}:Q4` });

  await writeFiles({ repository, paths: ['Q4.gguf'], destination });
  await expect(resolveRepositoryModel({ name: `hf.co/${repository}:Q4` })).rejects.toThrow('unsupported-input');
  expect((await storedModelDirectory({ name: accepted })).files.map(file => file.path)).toEqual([path]);
  expect((await prepareModelRemoval({ id: accepted })).plan.files.map(file => file.path)).toEqual([path]);
});

it('publishes the registered folder alias and shared quantization label together', async () => {
  const destination = { kind: 'host' as const, directoryId: 'root' };
  const path = `${prefix}Q4_K_M.gguf`;
  await writeFiles({ repository, paths: [path], destination });
  const directories = [{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'models-for-browser' }];
  const models = await listHostStoredModels({ directories, signal: undefined });
  expect(models[0]?.name).toBe('host/models-for-browser/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M');
  const selected = await selectHostModel({ name: resolveHostModelName({ name: models[0]!.name, directories }) });
  expect(selected.id).toBe(models[0]?.id); expect(selected.modelPath).toBe(path);
});
