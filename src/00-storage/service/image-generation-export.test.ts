import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, expect, it } from 'vitest';
import { vi } from 'vitest';
import { idToRaw, toImageGenerationTagId } from '@/01-models/ids';
import * as service from './image-generation';
import { collectImageGenerationSessionMetadata } from './image-generation-export';
import { createImageGenerationStorageHarness, generationRunFixture, generationSessionFixture, generationAssetFixture, generationDraftFixture } from './image-generation/test-support';
let fs: ReturnType<typeof createImageGenerationStorageHarness>;
beforeEach(() => {
  fs = createImageGenerationStorageHarness(); vi.stubGlobal('Blob', NodeBlob);
});
async function setup() {
  const catalog = await service.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' });
  if (!catalog) throw new Error('Missing catalog.');
  const store = { storageType: 'opfs' as const, storeId: catalog.id };
  const session = generationSessionFixture({ id: 'session-aa' }); await service.saveImageGenerationSession({ store, session, expectedRevision: undefined });
  const run = generationRunFixture({ id: 'run-aa', sessionId: session.id, count: 2, seed: '42' });
  await service.createImageGenerationRun({ store, run, writeInputs: async () => {} });
  await service.updateImageGenerationRunExecution({ store, sessionId: session.id, runId: run.id, expectedRevision: 0, execution: { type: 'running', startedAt: 3 } });
  const asset = generationAssetFixture({ id: 'asset-aa', run, index: 0 }); await service.commitImageGenerationAsset({ store, asset, writeImages: async () => {} });
  const tagId = toImageGenerationTagId({ raw: 'tag-aa' });
  await service.saveImageGenerationCatalog({
    store,
    expectedRevision: 0,
    catalog: {
      ...catalog,
      revision: 1,
      tags: [
        { id: tagId, name: '夜景', createdAt: 1, updatedAt: 1, state: 'active' },
        { id: toImageGenerationTagId({ raw: 'tag-bb' }), name: 'unrelated-private-tag', createdAt: 1, updatedAt: 1, state: 'active' },
      ],
    },
  });
  await service.setImageGenerationAssetTags({ store, sessionId: session.id, assetId: asset.id, tags: [{ type: 'user', tagId }], assignedAt: 3, expectedRevision: 0 });
  await service.saveImageGenerationDraft({ store, draft: generationDraftFixture({ sessionId: session.id }), expectedRevision: undefined, writeInputs: async () => {} });
  return { store, session, run, asset };
}
it('captures canonical metadata plus all input, result and preview references without leaking unused tags', async () => {
  const h = await setup(); const snapshot = await collectImageGenerationSessionMetadata({ store: h.store, sessionId: h.session.id });
  expect(snapshot.binaryObjectIds.map(id => idToRaw({ id })).sort()).toEqual(['input-aa', 'reference-aa', 'binary-asset-aa', 'preview-asset-aa'].sort());
  expect(snapshot.metadata.map(entry => entry.path).sort()).toEqual(['session.json', 'draft.json', 'runs/aa/run-aa.json', 'assets/aa/asset-aa.json', 'annotations/aa/asset-aa.json', 'catalog.json'].sort());
  const catalog = await snapshot.metadata.find(entry => entry.path === 'catalog.json')!.blob.text();
  expect(catalog).toContain('夜景'); expect(catalog).not.toContain('unrelated-private-tag');
  const run = await snapshot.metadata.find(entry => entry.path === 'runs/aa/run-aa.json')!.blob.text();
  expect(run).toContain('running'); // Partial runs remain exportable, never fabricated as completed.
});
it('retains a snapshot even if the original file changes afterwards', async () => {
  const h = await setup(); const snapshot = await collectImageGenerationSessionMetadata({ store: h.store, sessionId: h.session.id });
  const file = await fs.file({ path: '/naidan-storage/experimental/image-generation/sessions/aa/session-aa/session.json' }); file.text = '{broken';
  expect(await snapshot.metadata.find(entry => entry.path === 'session.json')!.blob.text()).toContain('雨の夜景');
});
it.each(['draft', 'asset', 'annotations'])('fails explicitly on unknown %s metadata instead of producing an incomplete archive', async kind => {
  const h = await setup();
  const part = kind === 'draft' ? 'draft.json' : kind === 'asset' ? 'assets/aa/asset-aa.json' : 'annotations/aa/asset-aa.json';
  const file = await fs.file({ path: `/naidan-storage/experimental/image-generation/sessions/aa/session-aa/${part}` });
  file.text = JSON.stringify({ ...JSON.parse(file.text), future: true });
  if (kind !== 'draft') {
    const directory = await fs.directory({ path: `/naidan-storage/experimental/image-generation/sessions/aa/session-aa/${kind === 'asset' ? 'assets' : 'annotations'}/aa` });
    await directory.removeEntry('index.json'); // Require reconstruction from canonical data.
  }
  await expect(collectImageGenerationSessionMetadata({ store: h.store, sessionId: h.session.id })).rejects.toThrow();
  expect(file.text).toContain('future');
});
it('excludes translation destinations and authentication from shareable session exports', async () => {
  const h = await setup();
  const translation = { endpoint: { type: 'openai' as const, url: 'https://private-translator.test', httpHeaders: [['Authorization', 'private-secret']] as [string, string][] }, modelId: 'private-model', lmParameters: undefined };
  const catalog = await service.loadImageGenerationCatalog({ store: h.store });
  await service.saveImageGenerationCatalog({ store: h.store, expectedRevision: catalog.revision, catalog: { ...catalog, revision: catalog.revision + 1, preferences: { ...catalog.preferences, translation } } });
  await service.saveImageGenerationSession({ store: h.store, session: { ...h.session, revision: 1, translation }, expectedRevision: 0 });
  const snapshot = await collectImageGenerationSessionMetadata({ store: h.store, sessionId: h.session.id });
  for (const entry of snapshot.metadata) {
    const text = await entry.blob.text();
    expect(text).not.toContain('private-secret'); expect(text).not.toContain('private-translator'); expect(text).not.toContain('private-model');
  }
  expect((await service.loadImageGenerationCatalog({ store: h.store })).preferences.translation).toEqual(translation);
});
