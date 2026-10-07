import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { listStoredModels } from './runtime/model-store';
import { listHostStoredModels, recordOpfsInventoryIssue } from './runtime/host-model-store';
import { llamaCppBrowserService } from './index-hosted';
vi.mock('@/00-storage/service', () => ({ storageService: { loadHostModelDirectories: vi.fn() } }));
vi.mock('./runtime/model-store', () => ({ listStoredModels: vi.fn(), removeStoredModel: vi.fn(), withModelMutationLock: vi.fn() }));
vi.mock('./runtime/host-model-store', () => ({ listHostStoredModels: vi.fn(), recordOpfsInventoryIssue: vi.fn() }));
const opfs = { id: 'hf.co/owner/repo:model.gguf', name: 'hf.co/owner/repo:model', size: 128, importedAt: 1 };
const host = { id: 'host/root/owner/repo:model.gguf', name: 'host/root/owner/repo:model.gguf', size: 128, importedAt: 1 };
const directories = [{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'models' }];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(storageService.loadHostModelDirectories).mockResolvedValue(directories);
  vi.mocked(listStoredModels).mockResolvedValue([opfs]);
  vi.mocked(listHostStoredModels).mockResolvedValue([host]);
});

describe('aggregated local model service', () => {
  it('keeps source-qualified copies in OPFS and linked folders as separate choices', async () => {
    expect(await llamaCppBrowserService.listModels({ signal: undefined })).toEqual([opfs, host]);
    expect(listHostStoredModels).toHaveBeenCalledWith({ directories, signal: undefined });
  });

  it('keeps linked models available and exposes an OPFS failure', async () => {
    const error = new Error('OPFS unavailable'); vi.mocked(listStoredModels).mockRejectedValue(error);
    expect(await llamaCppBrowserService.listModels({ signal: undefined })).toEqual([host]);
    expect(recordOpfsInventoryIssue).toHaveBeenCalledWith({ error });
  });

  it('preserves existing failure behavior when no linked roots exist', async () => {
    vi.mocked(storageService.loadHostModelDirectories).mockResolvedValue([]);
    vi.mocked(listStoredModels).mockRejectedValue(new Error('OPFS unavailable'));
    await expect(llamaCppBrowserService.listModels({ signal: undefined })).rejects.toThrow('OPFS unavailable');
  });
});
