// @vitest-environment node
import { effectScope, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import { useImageLibrary } from './use-image-library';
import { scanImageRepositories } from './logic/model-candidates';
import type { LocalImageRepository } from './logic/repository-store';
import { ggufFixture, zImageTensors } from './test-utils/weights';
vi.mock('./logic/repository-input', () => ({
  imageDirectoriesFromDrop: async () => [{ name: 'first', files: [] }, { name: 'second', files: [] }],
  imageDirectoryFromFiles: vi.fn(),
}));

function importedRepository(): LocalImageRepository {
  const file = ggufFixture({ name: 'z-image.gguf', tensors: zImageTensors, metadata: {}, extraBytes: 0 }).file;
  return { id: 'user/imported', name: 'imported', files: [{ path: file.name, file }] };
}

it.each(['before inspection', 'during inspection'] as const)('publishes an import after independent saving finishes %s', async timing => {
  const blocked = ref(false), entries = [importedRepository()];
  const pending = Promise.withResolvers<LocalImageRepository[]>();
  const list = vi.fn(async () => entries);
  const importing = vi.fn(async () => {
    if (timing === 'before inspection') blocked.value = true;
    return 'user/imported';
  });
  if (timing === 'during inspection') list.mockReturnValueOnce(pending.promise);
  const scope = effectScope();
  const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => blocked.value, onSelection: vi.fn(), dependencies: { list, scan: scanImageRepositories, import: importing, download: vi.fn() } }))!;
  try {
    const operation = library.dropDirectory({ event: { dataTransfer: {} } as DragEvent });
    if (timing === 'during inspection') {
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
      blocked.value = true; pending.resolve(entries);
    }
    await new Promise(resolve => setImmediate(resolve));
    expect(library.importing.value).toBe(true);
    expect(library.models.value).toEqual([]);
    blocked.value = false; await operation;
    expect(library.models.value).toHaveLength(1);
    expect(library.importing.value).toBe(false);
    expect(importing).toHaveBeenCalledTimes(2);
  } finally {
    scope.stop();
  }
});

it('settles a cancelled import publication and permits a later import without stale publication', async () => {
  const blocked = ref(false), entries = [importedRepository()];
  const list = vi.fn(async () => entries);
  const importing = vi.fn(async () => {
    blocked.value = true; return 'user/imported';
  });
  const scope = effectScope();
  const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => blocked.value, onSelection: vi.fn(), dependencies: { list, scan: scanImageRepositories, import: importing, download: vi.fn() } }))!;
  try {
    const first = library.dropDirectory({ event: { dataTransfer: {} } as DragEvent });
    await new Promise(resolve => setImmediate(resolve));
    expect(library.importing.value).toBe(true);
    library.cancelImport(); await first;
    expect(library.importing.value).toBe(false);
    blocked.value = false;
    importing.mockImplementation(async () => 'user/imported');
    await library.dropDirectory({ event: { dataTransfer: {} } as DragEvent });
    expect(list).toHaveBeenCalledOnce();
    expect(library.models.value).toHaveLength(1);
  } finally {
    scope.stop();
  }
});

it('refreshes successfully imported folders while preserving a later import error', async () => {
  const list = vi.fn(async () => []);
  const importRepo = vi.fn().mockResolvedValueOnce('user/first').mockRejectedValueOnce(new Error('second folder already exists'));
  const scope = effectScope();
  const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => false, onSelection: vi.fn(), dependencies: { list, scan: scanImageRepositories, import: importRepo, download: vi.fn() } }))!;
  try {
    await library.dropDirectory({ event: { dataTransfer: {} } as DragEvent });
    expect(importRepo).toHaveBeenCalledTimes(2); expect(list).toHaveBeenCalledOnce();
    expect(library.failure.value).toBe('second folder already exists');
    expect(library.importing.value).toBe(false);
  } finally {
    scope.stop();
  }
});

it('waits for an import to publish before a queued transfer starts after host operations finish', async () => {
  const importing = Promise.withResolvers<string>();
  const download = vi.fn(async () => undefined), list = vi.fn(async () => []);
  const scope = effectScope();
  const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => false, onSelection: vi.fn(), dependencies: { list, scan: scanImageRepositories, import: () => importing.promise, download } }))!;
  try {
    // Unlinking one active destination holds the host owner while a different
    // destination's explicitly queued job remains ready to run.
    library.hostDirectories.busy.value = true;
    const transfer = library.downloadRecipe({ recipeId: 'z-image-turbo', selections: {} });
    const operation = library.dropDirectory({ event: { dataTransfer: {} } as DragEvent });
    expect(library.importing.value).toBe(true);
    library.hostDirectories.busy.value = false;
    await new Promise(resolve => setImmediate(resolve));
    expect(download).not.toHaveBeenCalled();
    importing.resolve('user/imported'); await operation; await transfer;
    expect(download).toHaveBeenCalledOnce(); expect(list).toHaveBeenCalledTimes(2);
    expect(library.importing.value).toBe(false);
  } finally {
    scope.stop();
  }
});

it('removes a queued transfer during import without starting its download or touching stored files', async () => {
  const importing = Promise.withResolvers<string>();
  const download = vi.fn(async () => undefined), list = vi.fn(async () => []);
  const scope = effectScope();
  const library = scope.run(() => useImageLibrary({
    downloadsBlocked: () => false,
    blocked: () => false,
    onSelection: vi.fn(),
    dependencies: {
      list,
      scan: scanImageRepositories,
      import: () => importing.promise,
      download,
    },
  }))!;
  try {
    library.hostDirectories.busy.value = true;
    const transfer = library.downloadRecipe({ recipeId: 'z-image-turbo', selections: {} });
    const queued = library.downloadQueue.value[0]!;
    expect(queued.state).toBe('queued');
    const operation = library.dropDirectory({ event: { dataTransfer: {} } as DragEvent });
    expect(library.importing.value).toBe(true);
    library.removeQueuedDownload({ id: queued.id });
    await transfer;
    expect(library.downloadQueue.value).toEqual([]);
    expect(download).not.toHaveBeenCalled();
    library.hostDirectories.busy.value = false;
    importing.resolve('user/imported'); await operation;
    expect(download).not.toHaveBeenCalled();
  } finally {
    scope.stop();
  }
});
