// @vitest-environment node
import { effectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { useImageLibrary } from './use-image-library';
import { imageCatalogLoras } from './lora-catalog';
import { imageModelRecipes } from './model-recipes';
import type { ModelCandidate, ModelInventory } from './logic/model-candidates';
import type { ImageRecipeDownloadRequest } from './logic/catalog-download';
import type { ModelFileReceipt } from '@/logic/model-file-publication';

const entry = imageCatalogLoras[0]!;
const scopes: ReturnType<typeof effectScope>[] = [];

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});

function adapter({ source, root }: { source: ModelFileReceipt['source'] | undefined, root: string | undefined }): ModelCandidate {
  const file = new File(['synthetic adapter'], entry.source.path);
  Object.defineProperty(file, 'size', { value: entry.source.size });
  return {
    id: `${root ?? 'opfs'}/adapter`,
    repositoryId: root ? `host/${root}/${entry.source.repository}` : `huggingface.co/${entry.source.repository}/resolve/main`,
    path: entry.source.path,
    files: [{ path: entry.source.path, file, ...(source ? { receipt: { version: 1, kind: 'naidan-model-file', size: file.size, lastModified: file.lastModified, source } as const } : {}) }],
    format: 'safetensors',
    size: file.size,
    family: 'unknown',
    classes: ['lora'],
    roles: [],
    evidence: [],
    issue: undefined,
    turboHint: false,
    variant: 'unknown',
    ...(root ? { hostSource: { directoryId: root, directoryName: root, repository: entry.source.repository } } : {}),
  };
}
const source = (): ModelFileReceipt['source'] => ({ kind: 'hugging-face', repository: entry.source.repository, revision: entry.source.revision, path: entry.source.path, sha256: entry.source.sha256 });
function harness() {
  const file = new File(['synthetic checkpoint'], 'model.gguf');
  const model: ModelCandidate = {
    id: 'model',
    repositoryId: 'user/model',
    path: file.name,
    files: [{ path: file.name, file }],
    format: 'gguf',
    size: file.size,
    family: 'sd-checkpoint',
    classes: [],
    roles: ['model'],
    evidence: [],
    issue: undefined,
    turboHint: false,
    variant: 'unknown',
  };
  const inventory: ModelInventory = { candidates: [model], issues: [] };
  const download = vi.fn(async (_request: ImageRecipeDownloadRequest) => {});
  const onSelection = vi.fn(), scope = effectScope(); scopes.push(scope);
  const library = scope.run(() => useImageLibrary({ downloadsBlocked: () => false, blocked: () => false, onSelection, dependencies: { list: async () => [], scan: async () => inventory, import: vi.fn(), download } }))!;
  return { inventory, download, library, onSelection };
}

it('downloads only the optional adapter and preserves the chosen base and its readiness', async () => {
  const h = harness(); await h.library.refresh(); h.onSelection.mockClear();
  const base = h.library.selectedModels();
  h.download.mockImplementation(async () => {
    h.inventory.candidates.push(adapter({ source: source(), root: undefined }));
  });
  await h.library.downloadLora({ id: entry.id });
  expect(h.download).toHaveBeenCalledOnce(); expect(h.download.mock.calls[0]![0].files).toEqual([entry.source]);
  expect(h.download.mock.calls[0]![0].destination).toEqual({ kind: 'opfs' });
  expect(h.library.downloadLoraId.value).toBe(entry.id); expect(h.library.downloadRecipeId.value).toBe('');
  expect(h.library.downloadState.value).toBe('complete'); expect(h.library.loraAvailable({ id: entry.id })).toBe(true);
  expect(h.library.main.value).toBe('model'); expect(h.library.ready.value).toBe(true); expect(h.library.selectedModels()).toEqual(base);
  expect(h.onSelection).not.toHaveBeenCalled(); expect(h.library.savedLoras.value).toHaveLength(1);
  expect(imageModelRecipes.find(recipe => recipe.id === entry.recipeId)?.components.map(item => item.role)).toEqual(['diffusion', 'vae', 'lm']);
});

it('requires the exact publication receipt in the selected destination, not any selectable adapter', async () => {
  const h = harness();
  h.inventory.candidates.push(adapter({ source: undefined, root: 'host-root' }));
  await h.library.refresh(); h.library.hostDirectories.destination.value = 'host-root';
  expect(h.library.savedLoras.value).toHaveLength(1); expect(h.library.loraAvailable({ id: entry.id })).toBe(false);
  for (const changed of [{ sha256: '0'.repeat(64) }, { repository: 'other/repo' }, { revision: '0'.repeat(40) }, { path: 'other.safetensors' }]) {
    h.inventory.candidates[1] = adapter({ source: { ...source(), ...changed }, root: 'host-root' });
    await h.library.refresh(); expect(h.library.loraAvailable({ id: entry.id })).toBe(false);
  }
  h.inventory.candidates[1] = adapter({ source: source(), root: 'host-root' }); await h.library.refresh();
  expect(h.library.loraAvailable({ id: entry.id })).toBe(true);
  h.library.hostDirectories.destination.value = 'opfs'; expect(h.library.loraAvailable({ id: entry.id })).toBe(false);
});

it('resumes an adapter download independently of recipe selections and never promotes markerless output to complete', async () => {
  const h = harness(); await h.library.refresh();
  h.download.mockRejectedValueOnce(new Error('interrupted'));
  await h.library.downloadLora({ id: entry.id }); expect(h.library.downloadState.value).toBe('failed');
  h.download.mockImplementation(async () => {
    h.inventory.candidates.push(adapter({ source: undefined, root: undefined }));
  });
  await h.library.resumeDownload();
  expect(h.download.mock.calls[1]![0].files).toEqual([entry.source]); expect(h.library.downloadState.value).toBe('incomplete');
  expect(h.library.main.value).toBe('model');
  h.library.resetDownloadIntent(); expect(h.library.downloadLoraId.value).toBe(entry.id);
  const job = h.library.downloadQueue.value[0]!; h.library.removeQueuedDownload({ id: job.id });
  expect(h.library.downloadLoraId.value).toBe(''); expect(h.library.downloadRecipeId.value).toBe('');
});
