// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { MemoryDirectory } from '@/features/stable-diffusion-cpp-browser/test-utils/storage.test-support';
import type { ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination-types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { resolveHostModel, listHostStoredModels } from '@/features/llama-cpp-browser/runtime/host-model-store';
import { prepareModelRemoval, removeStoredModel } from '@/features/llama-cpp-browser/runtime/model-store';
import { resolveModel } from '@/features/llama-cpp-browser/runtime/model-resolution';
import { storageService } from '@/00-storage/service';
import { listHuggingFaceModels, repositoryDirectories, repositoryFolder, resolveRepositoryModel, selectedFile } from './storage';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));
vi.mock('@/00-storage/service', () => ({ storageService: { loadHostModelDirectories: vi.fn() } }));
vi.mock('@/utils/worker-transport', () => ({ releaseWorkerRemote: vi.fn() }));
const repository = 'LiquidAI/LFM2.5-230M-GGUF';
const prefix = 'LFM2.5-230M-';
let root: MemoryDirectory;
const directories = [{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'Models' }];

beforeEach(() => {
  root = new MemoryDirectory('models');
  vi.mocked(storageService.loadHostModelDirectories).mockReset().mockResolvedValue(directories);
  vi.mocked(hostModelHandles.get).mockResolvedValue(root as unknown as HostModelDirectoryHandle);
  const opfs = new MemoryDirectory('opfs');
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs }, locks: { request: async (_name: string, optionsOrOperation: object | (() => Promise<unknown>), operation?: (lock: object) => Promise<unknown>) => typeof optionsOrOperation === 'function' ? optionsOrOperation() : operation!({}) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function writeFiles({ repository, paths, destination }: { repository: string, paths: string[], destination: ModelDestination }) {
  const folder = await repositoryFolder({ repository, create: true, destination });
  for (const path of paths) {
    const writer = await (await selectedFile({ folder, path, create: true })).createWritable();
    const bytes = new Uint8Array(128);
    bytes.set([71, 71, 85, 70, 3, 0, 0, 0]);
    await writer.write(bytes);
    await writer.close();
  }
  return folder;
}

describe.each(['opfs', 'host'] as const)('%s shared local variants', kind => {
  const destination: ModelDestination = kind === 'host' ? { kind, directoryId: 'root' } : { kind };
  const modelIdForSelector = ({ selector }: { selector: string }) => kind === 'host'
    ? `host/Models/${repository}:${selector}`
    : `hf.co/${repository}:${selector}`;
  const resolve = async ({ selector }: { selector: string }) => kind === 'host'
    ? (await resolveHostModel({ modelId: modelIdForSelector({ selector }), directories, signal: undefined })).directory
    : resolveRepositoryModel({ modelId: modelIdForSelector({ selector }), signal: undefined });
  const publicModels = () => kind === 'host' ? listHostStoredModels({ directories, signal: undefined }) : listHuggingFaceModels({ destination });
  const resolvePublic = async ({ modelId }: { modelId: string }) => kind === 'host'
    ? (await resolveHostModel({ modelId, directories, signal: undefined })).directory
    : resolveRepositoryModel({ modelId, signal: undefined });

  it.each([
    {
      layout: 'quantization directory with four shards',
      repository: 'unsloth/Model-GGUF',
      groups: [{
        variant: 'UD-Q4_K_XL',
        paths: [
          'UD-Q4_K_XL/Model-UD-Q4_K_XL-00001-of-00004.gguf',
          'UD-Q4_K_XL/Model-UD-Q4_K_XL-00002-of-00004.gguf',
          'UD-Q4_K_XL/Model-UD-Q4_K_XL-00003-of-00004.gguf',
          'UD-Q4_K_XL/Model-UD-Q4_K_XL-00004-of-00004.gguf',
        ],
      }],
    },
    {
      layout: 'model and quantization repeated in the directory',
      repository: 'bartowski/Model-GGUF',
      groups: [{ variant: 'Q8_0', paths: ['Model-Q8_0/Model-Q8_0-00001-of-00002.gguf', 'Model-Q8_0/Model-Q8_0-00002-of-00002.gguf'] }],
    },
    {
      layout: 'lowercase root filenames with both single and split models',
      repository: 'Qwen/Model-GGUF',
      groups: [
        { variant: 'q2_k', paths: ['model-q2_k.gguf'] },
        { variant: 'q4_k_m', paths: ['model-q4_k_m-00001-of-00002.gguf', 'model-q4_k_m-00002-of-00002.gguf'] },
      ],
    },
    {
      layout: 'dot separator after a dotted model version',
      repository: 'TheBloke/Model-v0.2-GGUF',
      groups: [{ variant: 'Q4_K_M', paths: ['model-v0.2.Q4_K_M.gguf'] }],
    },
    {
      layout: 'meaningful ancestors above repeated quantization directories',
      repository: 'owner/Model-GGUF',
      groups: [
        { variant: 'imatrix/Q4_K_M', paths: ['imatrix/Q4_K_M/Model-Q4_K_M.gguf'] },
        { variant: 'plain/Q4_K_M', paths: ['plain/Q4_K_M/Model-Q4_K_M.gguf'] },
      ],
    },
    {
      layout: 'different model families in one repository',
      repository: 'owner/various-2bit-sota-gguf',
      groups: [
        { variant: 'llama-v2-13b-2.17bpw', paths: ['llama-v2-13b-2.17bpw.gguf'] },
        { variant: 'mistral-7b-2.20bpw', paths: ['mistral-7b-2.20bpw.gguf'] },
      ],
    },
    {
      layout: 'unknown modifiers and model sizes outside the repository prefix',
      repository: 'owner/Model-GGUF',
      groups: [
        { variant: 'i1-MXFP4', paths: ['Model-i1-MXFP4.gguf'] },
        { variant: '35B-FutureMethod-q4_Custom', paths: ['Model-35B-FutureMethod-q4_Custom.gguf'] },
      ],
    },
  ])('lists readable IDs and resolves every file in $layout', async ({ repository, groups }) => {
    await writeFiles({ repository, paths: groups.flatMap(group => group.paths), destination });
    const prefix = kind === 'host' ? `host/Models/${repository}` : `hf.co/${repository}`;
    const models = await publicModels();
    expect(models.map(model => model.modelId).sort()).toEqual(groups.map(group => `${prefix}:${group.variant}`).sort());
    for (const group of groups) {
      const selected = await resolvePublic({ modelId: `${prefix}:${group.variant}` });
      expect(selected.primaryFile.relativePath).toBe(group.paths[0]);
      expect(selected.files.map(file => file.relativePath).sort()).toEqual([...group.paths].sort());
      expect(selected.primaryFile).toBe(selected.files.find(file => file.relativePath === group.paths[0]));
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
  ])('lists and resolves the literal readable variant $variant', async ({ path, variant }) => {
    await writeFiles({ repository, paths: [path], destination });
    const models = await repositoryDirectories({ repository, destination });
    expect(models).toHaveLength(1);
    expect(models[0]?.primaryFile.relativePath).toBe(path);
    expect((await resolve({ selector: variant })).primaryFile.relativePath).toBe(path);
    const listed = await publicModels();
    expect(listed).toHaveLength(1);
    expect((await resolvePublic({ modelId: listed[0]!.modelId })).primaryFile.relativePath).toBe(path);
    expect(listed[0]?.modelId).toBe(modelIdForSelector({ selector: variant }));
    if (encodeURIComponent(path) !== variant) {
      await expect(resolve({ selector: encodeURIComponent(path) })).rejects.toThrow('missing-model');
    }
  });

  it('hides both same-variant split and unsplit groups and rejects their legacy exact paths', async () => {
    const split = [`${prefix}Q4_K_M-00001-of-00002.gguf`, `${prefix}Q4_K_M-00002-of-00002.gguf`];
    const folder = await writeFiles({ repository, paths: split, destination });
    expect((await resolve({ selector: 'Q4_K_M' })).files.map(file => file.relativePath)).toEqual(split);

    const unsplit = `${prefix}Q4_K_M.gguf`;
    await writeFiles({ repository, paths: [unsplit, `${prefix}Q4_K_M-of-00002.gguf`], destination });
    expect(await repositoryDirectories({ repository, destination })).toHaveLength(3);
    expect((await publicModels()).map(model => model.modelId)).toEqual([modelIdForSelector({ selector: 'Q4_K_M-of-00002' })]);
    await expect(resolve({ selector: 'Q4_K_M' })).rejects.toThrow('unsupported-input');
    await expect(resolve({ selector: split[0]! })).rejects.toThrow('missing-model');
    await expect(resolve({ selector: unsplit })).rejects.toThrow('missing-model');
    await expect(resolve({ selector: 'Q4_K_M (split-00002)' })).rejects.toThrow('missing-model');

    await folder.removeEntry(unsplit);
    expect((await publicModels()).map(model => model.modelId)).toContain(modelIdForSelector({ selector: 'Q4_K_M' }));
    expect((await resolve({ selector: 'Q4_K_M' })).files.map(file => file.relativePath)).toEqual(split);
  });

  it.each(['Q4_K_M', 'custom:100%', 'nested/Q4'])('keeps the filename-looking variant %s.gguf separate from the concrete file path', async selector => {
    const path = `${selector}.gguf`;
    const parts = path.split('/');
    const leaf = parts.pop()!;
    const collision = [...parts, `${prefix}${leaf}.gguf`].join('/');
    await writeFiles({ repository, paths: [path, collision], destination });
    const listed = await publicModels();
    expect(listed.map(model => model.modelId)).toContain(modelIdForSelector({ selector: path }));
    expect((await resolve({ selector })).primaryFile.relativePath).toBe(path);
    expect((await resolve({ selector: path })).primaryFile.relativePath).toBe(collision);
    const legacyModelId = kind === 'host'
      ? `host/root/${repository}:${encodeURIComponent(path)}`
      : `hf.co/${repository}:${encodeURIComponent(path)}`;
    if (!listed.some(model => model.modelId === legacyModelId)) {
      await expect(resolvePublic({ modelId: legacyModelId })).rejects.toThrow('missing-model');
    }
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
    expect(await publicModels()).toEqual([]);
    await expect(resolve({ selector: 'Q4' })).rejects.toThrow('unsupported-input');
    await expect(resolve({ selector: 'Q8' })).rejects.toThrow('missing-model');
  });

  it('hides both models when removing a repeated directory creates the same short name', async () => {
    const paths = [`${prefix}Q4.gguf`, `Q4/${prefix}Q4.gguf`];
    await writeFiles({ repository, paths, destination });
    expect(await publicModels()).toEqual([]);
    await expect(resolve({ selector: 'Q4' })).rejects.toThrow('unsupported-input');
    for (const path of paths) {
      await expect(resolve({ selector: path })).rejects.toThrow('missing-model');
    }
  });

  it('omits incomplete split groups without hiding an unrelated complete model', async () => {
    await writeFiles({ repository, paths: [`${prefix}Q4-00001-of-00002.gguf`, `${prefix}Q8.gguf`], destination });
    expect((await publicModels()).map(model => model.modelId)).toEqual([kind === 'host' ? `host/Models/${repository}:Q8` : `hf.co/${repository}:Q8`]);
    await expect(resolve({ selector: 'Q4' })).rejects.toThrow('missing-model');
    expect((await resolve({ selector: 'Q8' })).files.map(file => file.relativePath)).toEqual([`${prefix}Q8.gguf`]);
  });

  it('keeps literal percent, colon and Unicode selectors in one readable namespace', async () => {
    const cases = [
      { variant: 'Q A', path: `${prefix}Q A.gguf` },
      { variant: 'Q%20A', path: `${prefix}Q%20A.gguf` },
      { variant: 'nested/custom:100%-日本語', path: `nested/${prefix}custom:100%-日本語.gguf` },
      { variant: 'literal%2F/Q4', path: `literal%2F/${prefix}Q4.gguf` },
    ];
    await writeFiles({ repository, paths: cases.map(entry => entry.path), destination });
    const publicPrefix = kind === 'host' ? `host/Models/${repository}` : `hf.co/${repository}`;
    expect((await publicModels()).map(model => model.modelId).sort()).toEqual(cases.map(entry => `${publicPrefix}:${entry.variant}`).sort());
    for (const { variant, path } of cases) {
      const selected = await resolvePublic({ modelId: `${publicPrefix}:${variant}` });
      expect(selected.primaryFile.relativePath).toBe(path);
    }
  });
});

it('resolves a registered public Host model ID to captured GGUF files and rejects opaque legacy references', async () => {
  const destination = { kind: 'host' as const, directoryId: 'root' };
  const path = `${prefix}model.bin.gguf`;
  await writeFiles({ repository, paths: [path], destination });
  const modelId = `host/Models/${repository}:model.bin`;
  const selected = await resolveHostModel({ modelId, directories, signal: undefined });
  expect(selected.modelId).toBe(modelId);
  expect(selected.directory.primaryFile.relativePath).toBe(path);
  expect((await resolveModel({ modelId, signal: undefined })).directory.primaryFile.relativePath).toBe(path);
  expect((await prepareModelRemoval({ modelId, signal: undefined })).plan.target).toMatchObject({ kind: 'model', modelId });
  const legacyModelId = `host/root/${repository}:${encodeURIComponent(path)}`;
  await expect(resolveModel({ modelId: legacyModelId, signal: undefined })).rejects.toThrow('missing-model');
  await expect(prepareModelRemoval({ modelId: legacyModelId, signal: undefined })).rejects.toThrow('missing-model');
});

it('never reinterprets a captured Host model as a differently named replacement variant', async () => {
  const destination = { kind: 'host' as const, directoryId: 'root' };
  const path = `${prefix}Q4.gguf`;
  const folder = await writeFiles({ repository, paths: [path], destination });
  const modelId = `host/Models/${repository}:Q4`;
  const accepted = await resolveModel({ modelId, signal: undefined });
  await folder.removeEntry(path);
  await writeFiles({ repository, paths: [`${prefix}${path}.gguf`], destination });
  expect(accepted.directory.primaryFile.relativePath).toBe(path);
  await expect(resolveModel({ modelId, signal: undefined })).rejects.toThrow('missing-model');
  await expect(prepareModelRemoval({ modelId, signal: undefined })).rejects.toThrow('missing-model');
});

it('never reinterprets a captured OPFS model as a differently named replacement variant', async () => {
  const destination = { kind: 'opfs' as const };
  const path = `${prefix}Q4.gguf`;
  const folder = await writeFiles({ repository, paths: [path], destination });
  const modelId = `hf.co/${repository}:Q4`;
  const accepted = await resolveModel({ modelId, signal: undefined });
  expect(accepted.directory.primaryFile.relativePath).toBe(path);

  await folder.removeEntry(path);
  await writeFiles({ repository, paths: [`${prefix}${path}.gguf`], destination });
  expect(accepted.directory.primaryFile.relativePath).toBe(path);
  await expect(resolveModel({ modelId, signal: undefined })).rejects.toThrow('missing-model');
  await expect(prepareModelRemoval({ modelId, signal: undefined })).rejects.toThrow('missing-model');
});

it('keeps captured OPFS files and the reviewed removal plan after the public model ID becomes ambiguous', async () => {
  const destination = { kind: 'opfs' as const };
  const path = `${prefix}Q4.gguf`;
  await writeFiles({ repository, paths: [path], destination });
  const modelId = `hf.co/${repository}:Q4`;
  const accepted = await resolveModel({ modelId, signal: undefined });
  const { plan } = await prepareModelRemoval({ modelId, signal: undefined });

  const folder = await writeFiles({ repository, paths: ['Q4.gguf'], destination });
  await expect(resolveRepositoryModel({ modelId, signal: undefined })).rejects.toThrow('unsupported-input');
  await expect(prepareModelRemoval({ modelId, signal: undefined })).rejects.toThrow('unsupported-input');
  expect(accepted.directory.files.map(file => file.relativePath)).toEqual([path]);
  expect(plan.files.map(file => file.relativePath)).toEqual([path]);
  expect(await removeStoredModel({ plan })).toBe('deleted');
  expect(await folder.getFileHandle('Q4.gguf')).toBeDefined();
});

it('publishes the registered folder alias and shared quantization label together', async () => {
  const destination = { kind: 'host' as const, directoryId: 'root' };
  const path = `${prefix}Q4_K_M.gguf`;
  await writeFiles({ repository, paths: [path], destination });
  const registrations = [{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'models-for-browser' }];
  const models = await listHostStoredModels({ directories: registrations, signal: undefined });
  const modelId = 'host/models-for-browser/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M';
  expect(models[0]?.modelId).toBe(modelId);
  const selected = await resolveHostModel({ modelId, directories: registrations, signal: undefined });
  expect(selected.modelId).toBe(models[0]?.modelId);
  expect(selected.directory.primaryFile.relativePath).toBe(path);
});
