import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import {
  DATA_DELETION_OPTIONS,
  FACTORY_RESET_OPTION_IDS,
  createDataDeletionPreview,
  executeDataDeletion,
  getDataDeletionOptionSupport,
  normalizeDataDeletionOptionIds,
} from './data-deletion';


vi.mock('@/00-storage/service', () => ({
  storageService: {
    openOpfsSpecialFileSystemDirectory: vi.fn(),
    clearOpfsSpecialFileSystem: vi.fn(),
  },
}));

describe('data-deletion logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps factory reset scoped to Naidan data plus all Cache Storage', () => {
    expect(FACTORY_RESET_OPTION_IDS).toEqual([
      'local-storage-naidan-all',
      'opfs-naidan-storage',
      'opfs-naidan-tmp',
      'opfs-models',
      'indexed-db-naidan-volumes',
      'cache-storage-all',
    ]);
  });

  it('deduplicates advanced child selectors when their parent selector is selected', () => {
    const normalized = normalizeDataDeletionOptionIds({
      selectedOptionIds: new Set([
        'local-storage-naidan-all',
        'local-storage-lsp',
        'opfs-naidan-storage',
        'opfs-naidan-storage-chat-contents',
        'opfs-models',
        'opfs-models-user',
        'cache-storage-all',
        'cache-storage-naidan-named',
      ]),
    });

    expect(normalized).toEqual([
      'local-storage-naidan-all',
      'opfs-naidan-storage',
      'opfs-models',
      'cache-storage-all',
    ]);
  });


  it('marks unsupported storage APIs as unavailable without removing the checkbox model', () => {
    const opfsOption = DATA_DELETION_OPTIONS.find(option => option.id === 'opfs-naidan-storage');
    expect(opfsOption).toBeDefined();
    if (opfsOption === undefined) throw new Error('missing opfs-naidan-storage option');

    expect(getDataDeletionOptionSupport({ option: opfsOption })).toMatchObject({
      status: 'unavailable',
    });
  });

  it('returns preview warnings instead of throwing when OPFS is unavailable', async () => {
    const preview = await createDataDeletionPreview({
      selectedOptionIds: new Set(['opfs-naidan-storage']),
    });

    expect(preview.status).toBe('partial');
    expect(preview.entries).toEqual([]);
    expect(preview.notes).toEqual(['OPFS is unavailable in this runtime.']);
  });

  it('previews all actual localStorage keys matched by selected selectors', async () => {
    localStorage.setItem('naidan:storage_type', 'opfs');
    localStorage.setItem('naidan:lsp:settings', '{"ok":true}');
    localStorage.setItem('naidan:lsp:hierarchy', '{"items":[]}');
    localStorage.setItem('other:shared', 'kept');

    const preview = await createDataDeletionPreview({
      selectedOptionIds: new Set(['local-storage-naidan-all']),
    });

    expect(preview.entries.map(entry => entry.path)).toEqual([
      'naidan:lsp:hierarchy',
      'naidan:lsp:settings',
      'naidan:storage_type',
    ]);
    expect(preview.entries.every(entry => entry.location === 'localStorage')).toBe(true);
  });

  it('previews and deletes the logical tmp filesystem through the active OPFS backend', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: vi.fn(),
      },
    });
    vi.mocked(storageService.openOpfsSpecialFileSystemDirectory).mockResolvedValue({
      type: 'direct_directory',
      handle: {} as FileSystemDirectoryHandle,
    });

    const preview = await createDataDeletionPreview({
      selectedOptionIds: new Set(['opfs-naidan-tmp']),
    });

    expect(preview).toEqual({
      status: 'ready',
      entries: [{ path: '/naidan-tmp', location: 'OPFS' }],
      notes: [],
    });
    expect(storageService.openOpfsSpecialFileSystemDirectory).toHaveBeenCalledWith({
      type: 'tmp',
      path: '/',
      create: false,
    });

    await expect(executeDataDeletion({
      selectedOptionIds: new Set(['opfs-naidan-tmp']),
    })).resolves.toMatchObject({
      deletedSelectors: ['OPFS: /naidan-tmp'],
      skippedSelectors: [],
      failedSelectors: [],
    });
    expect(storageService.clearOpfsSpecialFileSystem).toHaveBeenCalledWith({
      type: 'tmp',
    });
  });

});
