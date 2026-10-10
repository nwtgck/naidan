import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { listHuggingFaceModels } from '@/features/llama-cpp-browser/hugging-face/storage';
import { getHostModelInventoryIssues, listHostStoredModels } from './host-model-store';
import { hostModelReference } from './model-destination-types';

vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ listHuggingFaceModels: vi.fn(), repositoryDirectories: vi.fn() }));

function directory({ id, name }: { id: string, name: string }) {
  return { id: toHostModelDirectoryId({ raw: id }), name };
}

function storedModel({ directoryId }: { directoryId: string }) {
  const id = hostModelReference({ directoryId, repository: 'owner/repo', modelPath: 'nested/model.gguf' });
  return { id, name: `host/${directoryId}/owner/repo:nested%2Fmodel`, size: 128, importedAt: 1 };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('host model inventory public names', () => {
  it('changes only the public name while preserving the storage ID and original source fields', async () => {
    const directories = [directory({ id: 'opaque-root', name: 'My Models' })];
    const stored = storedModel({ directoryId: 'opaque-root' });
    vi.mocked(listHuggingFaceModels).mockResolvedValue([stored]);

    const models = await listHostStoredModels({ directories, signal: undefined });

    expect(models).toEqual([{
      ...stored,
      name: 'host/My%20Models/owner/repo:nested%2Fmodel',
      source: { kind: 'host', directoryId: 'opaque-root', directoryName: 'My Models', repository: 'owner/repo', path: 'nested/model.gguf' },
    }]);
    expect(stored.name).toBe('host/opaque-root/owner/repo:nested%2Fmodel');
    expect(listHuggingFaceModels).toHaveBeenCalledExactlyOnceWith({ destination: { kind: 'host', directoryId: 'opaque-root' }, onIssue: expect.any(Function) });
  });

  it.each([
    { names: ['Models', 'Models'], expected: 'Models-2' },
    { names: ['Models', 'Models', 'Models-2', 'Models-3'], expected: 'Models-4' },
  ])('reserves all registered names despite failed inventory: $expected', async ({ names, expected }) => {
    const directories = names.map((name, index) => directory({ id: `root-${index}`, name }));
    vi.mocked(listHuggingFaceModels).mockImplementation(async options => {
      const destination = options?.destination;
      if (destination?.kind === 'host' && destination.directoryId === 'root-1') return [storedModel({ directoryId: 'root-1' })];
      throw new Error('Linked model folder permission expired');
    });

    const models = await listHostStoredModels({ directories, signal: undefined });

    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe(`host/${expected}/owner/repo:nested%2Fmodel`);
    expect(models[0]?.id).toBe('host/root-1/owner/repo:nested%2Fmodel.gguf');
    expect(models[0]?.source?.directoryName).toBe('Models');
    expect(getHostModelInventoryIssues()).toContainEqual({ directoryId: 'root-0', directoryName: 'Models', message: 'Linked model folder permission expired' });
    expect(listHuggingFaceModels).toHaveBeenCalledTimes(directories.length);
  });

  it('does not start inventory for an already aborted operation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(listHostStoredModels({ directories: [directory({ id: 'root', name: 'Models' })], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });

    expect(listHuggingFaceModels).not.toHaveBeenCalled();
  });

  it('propagates an abort during a failed root instead of returning a renamed partial inventory', async () => {
    const controller = new AbortController();
    const directories = [directory({ id: 'first', name: 'Models' }), directory({ id: 'second', name: 'Models' })];
    vi.mocked(listHuggingFaceModels).mockImplementation(async () => {
      controller.abort();
      throw new Error('Interrupted root scan');
    });

    await expect(listHostStoredModels({ directories, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });

    expect(listHuggingFaceModels).toHaveBeenCalledTimes(1);
  });

  it('propagates an abort even if the last root scan successfully returns models', async () => {
    const controller = new AbortController();
    vi.mocked(listHuggingFaceModels).mockImplementation(async () => {
      controller.abort();
      return [storedModel({ directoryId: 'root' })];
    });

    await expect(listHostStoredModels({ directories: [directory({ id: 'root', name: 'Models' })], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
