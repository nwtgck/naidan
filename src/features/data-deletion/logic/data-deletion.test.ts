import { beforeEach, describe, expect, it } from 'vitest';
import {
  DATA_DELETION_OPTIONS,
  FACTORY_RESET_OPTION_IDS,
  createDataDeletionPreview,
  getDataDeletionOptionSupport,
  normalizeDataDeletionOptionIds,
} from './data-deletion';

describe('data-deletion logic', () => {
  beforeEach(() => {
    localStorage.clear();
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
});
