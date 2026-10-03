import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idToRaw, toImageGenerationTagId } from '@/01-models/ids';
import * as service from './image-generation';
import { deleteImageGenerationAsset, listImageGenerationRunAssets, setImageGenerationAssetState } from './image-generation-curation';
import { collectImageGenerationSessionMetadata } from './image-generation-export';
import { createImageGenerationStorageHarness, generationAssetFixture, generationDraftFixture, generationRunFixture, generationSessionFixture } from './image-generation/test-support';
let fs: ReturnType<typeof createImageGenerationStorageHarness>;
const root = '/naidan-storage/experimental/image-generation';
const annotationsPath = `${root}/sessions/aa/session-aa/annotations/00/asset-00.json`;
beforeEach(() => {
  fs = createImageGenerationStorageHarness(); vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => vi.unstubAllGlobals());
async function ready({ count, finish }: { count: number, finish: boolean }) {
  const catalog = await service.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' });
  if (!catalog) throw new Error('Missing test catalog.');
  const store = { storageType: 'opfs' as const, storeId: catalog.id };
  const session = generationSessionFixture({ id: 'session-aa' });
  await service.saveImageGenerationSession({ store, session, expectedRevision: undefined });
  const run = generationRunFixture({ id: 'run-aa', sessionId: session.id, count, seed: '42' });
  await service.createImageGenerationRun({ store, run, writeInputs: async () => {} });
  await service.updateImageGenerationRunExecution({ store, sessionId: session.id, runId: run.id, expectedRevision: 0, execution: { type: 'running', startedAt: 3 } });
  const assets = Array.from({ length: count }, (_, index) => generationAssetFixture({ id: `asset-${index.toString().padStart(2, '0')}`, run, index }));
  for (const asset of assets) await service.commitImageGenerationAsset({ store, asset, writeImages: async () => {} });
  if (finish) await service.updateImageGenerationRunExecution({ store, sessionId: session.id, runId: run.id, expectedRevision: 1, execution: { type: 'completed', finishedAt: 100 } });
  const asset = assets[0]!;
  return { store, catalog, session, run, assets, asset, key: { store, sessionId: session.id, assetId: asset.id } };
}
describe('image archive and global tag identity', () => {
  it('archives without changing any image bytes, request, or assigned tags, and restores it', async () => {
    const h = await ready({ count: 1, finish: true });
    await service.setImageGenerationAssetTags({ ...h.key, expectedRevision: 0, assignedAt: 7, tags: [{ type: 'system', key: 'favorite' }] });
    const before = (await fs.file({ path: `${root}/sessions/aa/session-aa/assets/00/asset-00.json` })).text;
    const archived = await setImageGenerationAssetState({ ...h.key, state: 'archived', expectedRevision: 1 });
    expect(archived).toMatchObject({ state: 'archived', revision: 2, tags: [{ tag: { type: 'system', key: 'favorite' }, assignedAt: 7 }] });
    await service.setImageGenerationAssetTags({ ...h.key, expectedRevision: 2, assignedAt: 10, tags: [] });
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.state).toBe('archived');
    await setImageGenerationAssetState({ ...h.key, state: 'active', expectedRevision: 3 });
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.state).toBe('active');
    expect((await fs.file({ path: `${root}/sessions/aa/session-aa/assets/00/asset-00.json` })).text).toBe(before);
    const exported = await collectImageGenerationSessionMetadata({ store: h.store, sessionId: h.session.id });
    expect(exported.binaryObjectIds).toContain(h.asset.result.binaryObjectId);
  });
  it('resolves all 64 outputs of a run rather than only one gallery page', async () => {
    const h = await ready({ count: 64, finish: true });
    const items = await listImageGenerationRunAssets({ store: h.store, sessionId: h.session.id, runId: h.run.id });
    expect(items).toHaveLength(64);
    for (const item of items) await setImageGenerationAssetState({ store: h.store, sessionId: h.session.id, assetId: item.id, expectedRevision: item.annotations.revision, state: 'archived' });
    expect((await listImageGenerationRunAssets({ store: h.store, sessionId: h.session.id, runId: h.run.id })).every(item => item.annotations.state === 'archived')).toBe(true);
  });
  it('detects concurrent annotation changes instead of overwriting them', async () => {
    const h = await ready({ count: 1, finish: true });
    await service.setImageGenerationAssetTags({ ...h.key, expectedRevision: 0, assignedAt: 1, tags: [{ type: 'system', key: 'favorite' }] });
    await expect(setImageGenerationAssetState({ ...h.key, expectedRevision: 0, state: 'archived' })).rejects.toThrow('conflict');
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.state).toBe('active');
  });
  it('rebuilds the archive index after a canonical write outlives its acknowledgement', async () => {
    const h = await ready({ count: 1, finish: true });
    fs.faults.add(`close:${root}/sessions/aa/session-aa/annotations/00/index.json`);
    await expect(setImageGenerationAssetState({ ...h.key, expectedRevision: 0, state: 'archived' })).rejects.toThrow();
    const snapshot = await service.readImageGenerationSessionIndex({ store: h.store, sessionId: h.session.id });
    expect(snapshot.annotations.items[0]?.state).toBe('archived');
    await setImageGenerationAssetState({ ...h.key, expectedRevision: 0, state: 'archived' });
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.revision).toBe(1);
  });
  it('shares one Unicode tag ID across sessions and renames only the global catalog', async () => {
    const h = await ready({ count: 1, finish: true });
    const other = generationSessionFixture({ id: 'session-bb' });
    await service.saveImageGenerationSession({ store: h.store, session: other, expectedRevision: undefined });
    const run = generationRunFixture({ id: 'run-bb', sessionId: other.id, count: 1, seed: '24' });
    await service.createImageGenerationRun({ store: h.store, run, writeInputs: async () => {} });
    await service.updateImageGenerationRunExecution({ store: h.store, sessionId: other.id, runId: run.id, expectedRevision: 0, execution: { type: 'running', startedAt: 3 } });
    const asset = generationAssetFixture({ id: 'asset-bb', run, index: 0 });
    await service.commitImageGenerationAsset({ store: h.store, asset, writeImages: async () => {} });
    const tagId = toImageGenerationTagId({ raw: 'tag-aa' });
    const catalog = { ...h.catalog, revision: 1, tags: [{ id: tagId, name: '夜景🌃', state: 'active' as const, createdAt: 1, updatedAt: 1 }] };
    await service.saveImageGenerationCatalog({ store: h.store, catalog, expectedRevision: 0 });
    for (const image of [h.asset, asset]) await service.setImageGenerationAssetTags({ store: h.store, sessionId: image.sessionId, assetId: image.id, expectedRevision: 0, assignedAt: 1, tags: [{ type: 'user', tagId }] });
    const written = fs.writes.length;
    await service.saveImageGenerationCatalog({ store: h.store, catalog: { ...catalog, revision: 2, tags: [{ ...catalog.tags[0]!, name: '採用候補🟦', updatedAt: 2 }] }, expectedRevision: 1 });
    expect(fs.writes.slice(written)).toEqual([`${root}/catalog.json`]);
    for (const image of [h.asset, asset]) expect((await service.loadImageGenerationAssetAnnotations({ store: h.store, sessionId: image.sessionId, assetId: image.id }))?.tags[0]?.tag).toEqual({ type: 'user', tagId });
    const current = await service.loadImageGenerationCatalog({ store: h.store });
    await expect(service.saveImageGenerationCatalog({ store: h.store, catalog: { ...current, revision: 3, tags: [...current.tags, { ...current.tags[0]!, id: toImageGenerationTagId({ raw: 'tag-bb' }), name: ' 採用候補🟦 ' }] }, expectedRevision: 2 })).rejects.toThrow();
  });
});
describe('permanent output deletion', () => {
  it('removes the output and saved previews only and forbids restoring a deleted asset', async () => {
    const h = await ready({ count: 1, finish: true }), removeBinary = vi.fn().mockResolvedValue(undefined);
    await deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary });
    expect(removeBinary.mock.calls.map(([value]) => value.binaryObjectId)).toEqual([h.asset.result.binaryObjectId, h.asset.previews[0]!.binaryObjectId]);
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.state).toBe('deleted');
    expect(await listImageGenerationRunAssets({ store: h.store, sessionId: h.session.id, runId: h.run.id })).toEqual([]);
    await expect(setImageGenerationAssetState({ ...h.key, expectedRevision: 2, state: 'active' })).rejects.toThrow('cannot be restored');
    await expect(service.setImageGenerationAssetTags({ ...h.key, expectedRevision: 2, assignedAt: 1, tags: [] })).rejects.toThrow();
    await deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary });
    expect(removeBinary).toHaveBeenCalledTimes(2);
  });
  it('will not delete when the run is active or the annotation revision is stale', async () => {
    const h = await ready({ count: 1, finish: false }), removeBinary = vi.fn();
    await expect(deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary })).rejects.toThrow('Wait');
    await expect(listImageGenerationRunAssets({ store: h.store, sessionId: h.session.id, runId: h.run.id })).rejects.toThrow('Wait');
    await service.updateImageGenerationRunExecution({ store: h.store, sessionId: h.session.id, runId: h.run.id, expectedRevision: 1, execution: { type: 'cancelled', finishedAt: 10 } });
    await setImageGenerationAssetState({ ...h.key, expectedRevision: 0, state: 'archived' });
    await expect(deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary })).rejects.toThrow('conflict');
    expect(removeBinary).not.toHaveBeenCalled();
  });
  it('persists pending deletion before removing bytes and retries after a partial failure', async () => {
    const h = await ready({ count: 1, finish: true });
    const removeBinary = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk failure')).mockResolvedValue(undefined);
    await expect(deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary })).rejects.toThrow('disk failure');
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.state).toBe('deleting');
    await expect(collectImageGenerationSessionMetadata({ store: h.store, sessionId: h.session.id })).rejects.toThrow('pending image deletions');
    await deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary });
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.state).toBe('deleted');
    expect(removeBinary).toHaveBeenCalledTimes(4);
  });
  it('does not remove bytes if writing the deletion marker fails', async () => {
    const h = await ready({ count: 1, finish: true }), removeBinary = vi.fn().mockResolvedValue(undefined);
    fs.faults.add(`open:${root}/deleted-binaries/00/binary-asset-00.json`);
    await expect(deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary })).rejects.toThrow();
    expect(removeBinary).not.toHaveBeenCalled();
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.state).toBe('deleting');
    // The generic writer removes an empty file left by its own failed creation.
    await deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary });
    expect(removeBinary).toHaveBeenCalledTimes(2);
  });
  it('does not resurrect deleted output bytes through a stale publication or new input', async () => {
    const h = await ready({ count: 1, finish: true }), removeBinary = vi.fn().mockResolvedValue(undefined);
    await deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary });
    const write = vi.fn().mockResolvedValue(undefined);
    await expect(service.commitImageGenerationAsset({ store: h.store, asset: h.asset, writeImages: write })).rejects.toThrow();
    const draft = generationDraftFixture({ sessionId: h.session.id });
    draft.request.imageInputs.initImage = { binaryObjectId: h.asset.result.binaryObjectId, name: 'deleted.png' };
    await expect(service.saveImageGenerationDraft({ store: h.store, draft, expectedRevision: undefined, writeInputs: write })).rejects.toThrow('permanently deleted');
    const run = { ...generationRunFixture({ id: 'run-bb', sessionId: h.session.id, count: 1, seed: '33' }), request: { ...h.run.request, parameters: { ...h.run.request.parameters, seed: '33' }, imageInputs: draft.request.imageInputs } };
    await expect(service.createImageGenerationRun({ store: h.store, run, writeInputs: write })).rejects.toThrow('permanently deleted');
    expect(write).not.toHaveBeenCalled();
  });
  it('exports deletion facts instead of trying to export removed bytes', async () => {
    const h = await ready({ count: 2, finish: true });
    await setImageGenerationAssetState({ store: h.store, sessionId: h.session.id, assetId: h.assets[1]!.id, expectedRevision: 0, state: 'archived' });
    await deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary: async () => {} });
    const snapshot = await collectImageGenerationSessionMetadata({ store: h.store, sessionId: h.session.id });
    expect(snapshot.binaryObjectIds).not.toContain(h.asset.result.binaryObjectId);
    expect(snapshot.binaryObjectIds).not.toContain(h.asset.previews[0]!.binaryObjectId);
    expect(snapshot.binaryObjectIds).toContain(h.assets[1]!.result.binaryObjectId);
    expect(snapshot.binaryObjectIds).toContain(h.run.request.imageInputs.initImage?.binaryObjectId);
    expect(snapshot.metadata.map(file => file.path)).toContain(`deleted-binaries/${idToRaw({ id: h.asset.result.binaryObjectId })}.json`);
  });
  it('retries the final metadata write without resurrecting files', async () => {
    const h = await ready({ count: 1, finish: true });
    const removeBinary = vi.fn(async () => {
      fs.faults.add(`close:${annotationsPath}`);
    });
    await expect(deleteImageGenerationAsset({ ...h.key, expectedRevision: 0, removeBinary })).rejects.toThrow();
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.state).toBe('deleting');
    await deleteImageGenerationAsset({ ...h.key, expectedRevision: 1, removeBinary: async () => {} });
    expect((await service.loadImageGenerationAssetAnnotations(h.key))?.state).toBe('deleted');
  });
});
