// @vitest-environment node
import { effectScope } from 'vue';
import { expect, it, vi } from 'vitest';
import { useImageLibrary } from './use-image-library';
import { scanImageRepositories } from './logic/model-candidates';
vi.mock('./logic/repository-input', () => ({
  imageDirectoriesFromDrop: async () => [{ name: 'first', files: [] }, { name: 'second', files: [] }],
  imageDirectoryFromFiles: vi.fn(),
}));
it('refreshes successfully imported folders while preserving a later import error', async () => {
  const list = vi.fn(async () => []);
  const importRepo = vi.fn().mockResolvedValueOnce('user/first').mockRejectedValueOnce(new Error('second folder already exists'));
  const scope = effectScope();
  const library = scope.run(() => useImageLibrary({ blocked: () => false, onSelection: vi.fn(), dependencies: { list, scan: scanImageRepositories, import: importRepo, download: vi.fn() } }))!;
  try {
    await library.dropDirectory({ event: { dataTransfer: {} } as DragEvent });
    expect(importRepo).toHaveBeenCalledTimes(2); expect(list).toHaveBeenCalledOnce();
    expect(library.failure.value).toBe('second folder already exists');
    expect(library.importing.value).toBe(false);
  } finally {
    scope.stop();
  }
});
