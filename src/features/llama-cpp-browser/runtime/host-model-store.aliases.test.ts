import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { listHuggingFaceModels, repositoryDirectories } from '@/features/llama-cpp-browser/hugging-face/storage';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import { getHostModelInventoryIssues, listHostStoredModels, resolveHostModel } from './host-model-store';
import type { ModelDirectory } from './model-directory';

vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ listHuggingFaceModels: vi.fn(), repositoryDirectories: vi.fn() }));

function directory({ id, name }: { id: string, name: string }) {
  return { id: toHostModelDirectoryId({ raw: id }), name };
}

function storedModel({ directoryId, directoryName, modelId }: { directoryId: string, directoryName: string, modelId: string }): LocalModel {
  return {
    modelId,
    size: 128,
    importedAt: 1,
    source: { kind: 'host', directoryId, directoryName, repository: 'owner/repo', primaryRelativePath: 'nested/model.gguf' },
  };
}

function modelDirectory({ primaryRelativePath }: { primaryRelativePath: string }): ModelDirectory {
  const file = new File(['model bytes'], primaryRelativePath.split('/').at(-1)!);
  const handle = { kind: 'file', getFile: async () => file } as FileSystemFileHandle;
  const primaryFile = { storageKind: 'host' as const, relativePath: primaryRelativePath, file, handle };
  return { primaryFile, files: [primaryFile], projectorFile: undefined };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('host model inventory public modelIds', () => {
  it('returns the storage inventory modelId and captured source without creating a second identity', async () => {
    const directories = [directory({ id: 'opaque-root', name: 'My Models' })];
    const stored = storedModel({ directoryId: 'opaque-root', directoryName: 'My Models', modelId: 'host/My%20Models/owner/repo:nested/model' });
    vi.mocked(listHuggingFaceModels).mockResolvedValue([stored]);

    const models = await listHostStoredModels({ directories, signal: undefined });

    expect(models).toEqual([stored]);
    expect(models[0]).toBe(stored);
    expect(models[0]?.modelId).toBe('host/My%20Models/owner/repo:nested/model');
    expect(models[0]?.source?.primaryRelativePath).toBe('nested/model.gguf');
    expect(listHuggingFaceModels).toHaveBeenCalledExactlyOnceWith({ destination: { kind: 'host', directoryId: 'opaque-root' }, directories, signal: undefined, onIssue: expect.any(Function) });
  });

  it.each([
    { names: ['Models', 'Models'], expected: 'Models-2' },
    { names: ['Models', 'Models', 'Models-2', 'Models-3'], expected: 'Models-4' },
  ])('passes all registered roots to storage despite failed inventory so it can reserve $expected', async ({ names, expected }) => {
    const directories = names.map((name, index) => directory({ id: `root-${index}`, name }));
    const stored = storedModel({ directoryId: 'root-1', directoryName: 'Models', modelId: `host/${expected}/owner/repo:nested/model` });
    vi.mocked(listHuggingFaceModels).mockImplementation(async options => {
      const destination = options?.destination;
      if (destination?.kind === 'host' && destination.directoryId === 'root-1') {
        return [stored];
      }
      throw new Error('Linked model folder permission expired');
    });

    const models = await listHostStoredModels({ directories, signal: undefined });

    expect(models).toEqual([stored]);
    expect(models[0]?.modelId).toBe(`host/${expected}/owner/repo:nested/model`);
    expect(models[0]?.source?.directoryId).toBe('root-1');
    expect(models[0]?.source?.directoryName).toBe('Models');
    expect(getHostModelInventoryIssues()).toContainEqual({ directoryId: 'root-0', directoryName: 'Models', message: 'Linked model folder permission expired' });
    expect(listHuggingFaceModels).toHaveBeenCalledTimes(directories.length);
    for (const root of directories) {
      expect(listHuggingFaceModels).toHaveBeenCalledWith({ destination: { kind: 'host', directoryId: root.id }, directories, signal: undefined, onIssue: expect.any(Function) });
    }
  });

  it('does not start inventory for an already aborted operation', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(listHostStoredModels({ directories: [directory({ id: 'root', name: 'Models' })], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });

    expect(listHuggingFaceModels).not.toHaveBeenCalled();
  });

  it('propagates an abort during a failed root instead of returning a partial inventory', async () => {
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
      return [storedModel({ directoryId: 'root', directoryName: 'Models', modelId: 'host/Models/owner/repo:nested/model' })];
    });

    await expect(listHostStoredModels({ directories: [directory({ id: 'root', name: 'Models' })], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('host model resolution', () => {
  it('returns the current modelId with its structured location and captured source files', async () => {
    const directories = [directory({ id: 'root', name: 'Models' })];
    const selected = modelDirectory({ primaryRelativePath: 'nested/model.gguf' });
    vi.mocked(repositoryDirectories).mockResolvedValue([selected, modelDirectory({ primaryRelativePath: 'other.gguf' })]);
    const modelId = 'host/Models/owner/repo:nested/model';

    const resolved = await resolveHostModel({ modelId, directories, signal: undefined });

    expect(resolved).toEqual({ modelId, location: { kind: 'host', directoryId: 'root', repository: 'owner/repo' }, directory: selected });
    expect(resolved.directory).toBe(selected);
    expect(resolved.directory.primaryFile.file).toBe(selected.primaryFile.file);
    expect(repositoryDirectories).toHaveBeenCalledExactlyOnceWith({ repository: 'owner/repo', destination: { kind: 'host', directoryId: 'root' }, signal: undefined });
  });

  it('rejects a legacy exact reference instead of interpreting its opaque root ID as an alias', async () => {
    const directories = [directory({ id: 'root', name: 'Models' })];

    await expect(resolveHostModel({ modelId: 'host/root/owner/repo:nested%2Fmodel.gguf', directories, signal: undefined })).rejects.toThrow('missing-model');

    expect(repositoryDirectories).not.toHaveBeenCalled();
  });

  it('does not equate a legacy exact file selector with a readable modelId variant', async () => {
    const directories = [directory({ id: 'root', name: 'Models' })];
    vi.mocked(repositoryDirectories).mockResolvedValue([modelDirectory({ primaryRelativePath: 'nested/model.gguf' })]);

    await expect(resolveHostModel({ modelId: 'host/Models/owner/repo:nested%2Fmodel.gguf', directories, signal: undefined })).rejects.toThrow('missing-model');
  });

  it('rejects ambiguous current modelId variants rather than choosing the first file set', async () => {
    const directories = [directory({ id: 'root', name: 'Models' })];
    vi.mocked(repositoryDirectories).mockResolvedValue([
      modelDirectory({ primaryRelativePath: 'model.gguf' }),
      modelDirectory({ primaryRelativePath: 'repo-model.gguf' }),
    ]);

    await expect(resolveHostModel({ modelId: 'host/Models/owner/repo:model', directories, signal: undefined })).rejects.toThrow('unsupported-input');
  });

  it('propagates an abort after capturing a matching file set', async () => {
    const controller = new AbortController();
    const directories = [directory({ id: 'root', name: 'Models' })];
    vi.mocked(repositoryDirectories).mockImplementation(async () => {
      controller.abort();
      return [modelDirectory({ primaryRelativePath: 'model.gguf' })];
    });

    await expect(resolveHostModel({ modelId: 'host/Models/owner/repo:model', directories, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
