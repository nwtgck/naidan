import { selectImageGenerationAssets } from './asset-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { idToRaw, toImageGenerationAssetId, toImageGenerationSessionId, toImageGenerationTagId, type ImageGenerationSessionId } from '@/01-models/ids';
import type { ImageGenerationAssetQuery, ImageGenerationCatalog, ImageGenerationTagReference } from '@/01-models/image-generation';
import { SYNC_LOCK_KEY } from '@/constants';
import { createImageGenerationStorageHarness, generationAssetFixture, generationRunFixture, generationSessionFixture } from '@/00-storage/service/image-generation/test-support';
import { commitImageGenerationAsset, createImageGenerationRun, listImageGenerationRuns, listImageGenerationSessions, loadImageGenerationAsset, loadImageGenerationAssetAnnotations, loadImageGenerationCatalog, loadImageGenerationRun, loadImageGenerationSession, openImageGenerationStore, readImageGenerationSessionIndex, saveImageGenerationCatalog, saveImageGenerationSession, setImageGenerationAssetTags, updateImageGenerationRunExecution, type ImageGenerationStoreAccess } from '@/00-storage/service/image-generation';

const rootPath = '/naidan-storage/experimental/image-generation';
const favorite: ImageGenerationTagReference = { type: 'system', key: 'favorite' };
// The input here is typed test data; runtime queries use the Worker's schema.
async function queryImageGenerationAssets({ store, sessionId, query }: { store: ImageGenerationStoreAccess, sessionId: ImageGenerationSessionId, query: ImageGenerationAssetQuery }) {
  return selectImageGenerationAssets({ snapshot: await readImageGenerationSessionIndex({ store, sessionId }), query });
}
const query: ImageGenerationAssetQuery = { visibility: 'active', text: '', tags: [], match: 'all', runId: undefined, cursor: undefined, limit: 20 };
let h: ReturnType<typeof createImageGenerationStorageHarness>;
beforeEach(() => {
  h = createImageGenerationStorageHarness();
});

async function createStore(): Promise<{ store: ImageGenerationStoreAccess, catalog: ImageGenerationCatalog }> {
  const catalog = await openImageGenerationStore({ storageType: 'opfs', creation: 'allow' });
  if (!catalog) throw new Error('Missing fixture catalog.');
  return { catalog, store: { storageType: 'opfs', storeId: catalog.id } };
}
async function start({ count }: { count: number }) {
  const { store, catalog } = await createStore();
  const session = await saveImageGenerationSession({ store, session: generationSessionFixture({ id: 'session-aB' }), expectedRevision: undefined });
  const run = generationRunFixture({ id: 'run-cD', sessionId: session.id, count, seed: '42' });
  await createImageGenerationRun({ store, run, writeInputs: async () => {} });
  const accepted = await loadImageGenerationRun({ store, sessionId: session.id, runId: run.id });
  if (!accepted) throw new Error('Missing accepted fixture run.');
  await updateImageGenerationRunExecution({ store, sessionId: session.id, runId: run.id, execution: { type: 'running', startedAt: 3 }, expectedRevision: 0 });
  return { store, catalog, session, run: accepted };
}
async function published() {
  const context = await start({ count: 1 });
  const asset = generationAssetFixture({ id: 'asset-eF', run: context.run, index: 0 });
  await commitImageGenerationAsset({ store: context.store, asset, writeImages: async () => {} });
  return { ...context, asset };
}
function sessionPath({ id }: { id: ImageGenerationSessionId }): string {
  const raw = idToRaw({ id });
  return `${rootPath}/sessions/${raw.slice(-2).toLowerCase()}/${raw}`;
}

describe('catalog and session ownership', () => {
  it('does not create directories on read-only visits', async () => {
    expect(await openImageGenerationStore({ storageType: 'opfs', creation: 'forbid' })).toBeUndefined();
    expect(h.root.children.size).toBe(0); expect(h.writes).toEqual([]);
  });
  it.each(['local', 'memory'] as const)('does not touch OPFS for %s storage', async storageType => {
    await expect(openImageGenerationStore({ storageType, creation: 'allow' })).rejects.toThrow('requires OPFS');
    expect(h.getDirectory).not.toHaveBeenCalled();
  });
  it('requires locks instead of silently accepting cross-tab data loss', async () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: h.getDirectory } });
    await expect(openImageGenerationStore({ storageType: 'opfs', creation: 'allow' })).rejects.toThrow('Web Locks');
    expect(h.getDirectory).not.toHaveBeenCalled();
  });
  it('uses the replacement lock before the feature lock, and initializes only once across clients', async () => {
    const catalogs = await Promise.all(Array.from({ length: 8 }, () => openImageGenerationStore({ storageType: 'opfs', creation: 'allow' })));
    expect(new Set(catalogs.map(catalog => catalog?.id)).size).toBe(1);
    expect(h.writes).toEqual([`${rootPath}/catalog.json`]);
    expect(h.acquired.slice(0, 2)).toEqual([SYNC_LOCK_KEY, 'naidan-experimental-image-generation']);
  });
  it.each(['{broken', JSON.stringify({ version: 2, id: 'future-catalog', future: true })])('does not replace unreadable catalog %s', async text => {
    const { store } = await createStore(); const catalogFile = await h.file({ path: `${rootPath}/catalog.json` }); catalogFile.text = text;
    await expect(openImageGenerationStore({ storageType: 'opfs', creation: 'allow' })).rejects.toThrow();
    await expect(listImageGenerationSessions({ store })).rejects.toThrow();
    expect(catalogFile.text).toBe(text);
  });
  it('does not recreate a missing catalog over existing sessions', async () => {
    const { store, session } = await start({ count: 1 });
    await (await h.directory({ path: rootPath })).removeEntry('catalog.json');
    await expect(openImageGenerationStore({ storageType: 'opfs', creation: 'allow' })).rejects.toThrow('catalog is missing');
    await expect(loadImageGenerationSession({ store, sessionId: session.id })).rejects.toThrow();
    expect((await h.file({ path: `${sessionPath({ id: session.id })}/session.json` })).text).toContain('雨の夜景');
  });
  it('invalidates captured store access after reset instead of recreating old work', async () => {
    const { store, session, run } = await start({ count: 1 });
    await (await h.directory({ path: '/naidan-storage/experimental' })).removeEntry('image-generation', { recursive: true });
    const replacement = await createStore(); expect(replacement.store.storeId).not.toBe(store.storeId);
    const writeImages = vi.fn();
    await expect(commitImageGenerationAsset({ store, asset: generationAssetFixture({ id: 'old-eF', run, index: 0 }), writeImages })).rejects.toThrow('store changed');
    await expect(saveImageGenerationSession({ store, session, expectedRevision: undefined })).rejects.toThrow('store changed');
    expect(writeImages).not.toHaveBeenCalled();
    expect((await listImageGenerationSessions({ store: replacement.store })).items).toEqual([]);
  });
  it('rejects invalid path identities before opening storage', async () => {
    const { store } = await createStore(); h.getDirectory.mockClear();
    await expect(loadImageGenerationSession({ store, sessionId: toImageGenerationSessionId({ raw: '@/features/image-generation/catalog' }) })).rejects.toThrow();
    await expect(saveImageGenerationSession({ store, session: generationSessionFixture({ id: 'a/b' }), expectedRevision: undefined })).rejects.toThrow();
    expect(h.getDirectory).not.toHaveBeenCalled();
  });
  it('round-trips unusual but safe identifiers without object prototype collisions', async () => {
    const { store } = await createStore();
    for (const id of ['constructor', '__proto__', 'prototype']) await saveImageGenerationSession({ store, session: generationSessionFixture({ id }), expectedRevision: undefined });
    expect((await listImageGenerationSessions({ store })).items).toHaveLength(3);
  });
  it('detects session rename conflicts and permits identical retries', async () => {
    const { store } = await createStore(); const session = generationSessionFixture({ id: 'session-aB' });
    await saveImageGenerationSession({ store, session, expectedRevision: undefined });
    const next = { ...session, title: '夜景の候補', updatedAt: 20, revision: 1 };
    await saveImageGenerationSession({ store, session: next, expectedRevision: 0 });
    await saveImageGenerationSession({ store, session: next, expectedRevision: 0 });
    await expect(saveImageGenerationSession({ store, session: { ...next, title: 'lost update' }, expectedRevision: 0 })).rejects.toThrow('conflict');
    expect((await loadImageGenerationSession({ store, sessionId: session.id }))?.title).toBe('夜景の候補');
  });
  it('serializes two competing catalog edits', async () => {
    const { store, catalog } = await createStore();
    const results = await Promise.allSettled(['夜景', '人物'].map((name, index) => saveImageGenerationCatalog({ store, expectedRevision: 0, catalog: { ...catalog, revision: 1, tags: [{ id: toImageGenerationTagId({ raw: `tag-${index}` }), name, state: 'active', createdAt: 1, updatedAt: 1 }] } })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await loadImageGenerationCatalog({ store })).tags).toHaveLength(1);
  });
});

describe('immutable generation records and explicit state', () => {
  it('preserves the complete request, including inactive adapters, host companions and input identities', async () => {
    const { store, session, run } = await start({ count: 4 });
    expect(await loadImageGenerationRun({ store, sessionId: session.id, runId: run.id })).toEqual({ ...run, revision: 1, execution: { type: 'running', startedAt: 3 } });
    const list = await listImageGenerationRuns({ store, sessionId: session.id });
    expect(list.items[0]).toMatchObject({ prompt: run.request.parameters.prompt, requestedCount: 4, modelName: 'main.gguf' });
    expect(list.warningCount).toBe(0);
  });
  it('does not publish metadata when input publication fails', async () => {
    const { store } = await createStore(); const session = generationSessionFixture({ id: 'session-aB' });
    await saveImageGenerationSession({ store, session, expectedRevision: undefined });
    const run = generationRunFixture({ id: 'run-cD', sessionId: session.id, count: 1, seed: '42' });
    await expect(createImageGenerationRun({ store, run, writeInputs: async () => {
      throw new Error('input bytes failed');
    } })).rejects.toThrow('input bytes failed');
    expect(await loadImageGenerationRun({ store, sessionId: session.id, runId: run.id })).toBeUndefined();
  });
  it('does not publish an asset before the binary callback succeeds', async () => {
    const { store, session, run } = await start({ count: 1 }); const asset = generationAssetFixture({ id: 'asset-eF', run, index: 0 });
    await expect(commitImageGenerationAsset({ store, asset, writeImages: async () => {
      throw new Error('disk full');
    } })).rejects.toThrow('disk full');
    expect(await loadImageGenerationAsset({ store, sessionId: session.id, assetId: asset.id })).toBeUndefined();
  });
  it('accepts identical asset retries but rejects altered bytes metadata and duplicate output slots', async () => {
    const { store, session, run, asset } = await published();
    await commitImageGenerationAsset({ store, asset, writeImages: async () => {} });
    const writeImages = vi.fn();
    await expect(commitImageGenerationAsset({ store, asset: { ...asset, result: { ...asset.result, modelVersion: 'changed' } }, writeImages })).rejects.toThrow('immutable');
    await expect(commitImageGenerationAsset({ store, asset: { ...asset, id: toImageGenerationAssetId({ raw: 'other-eF' }) }, writeImages })).rejects.toThrow('slot already');
    expect(writeImages).not.toHaveBeenCalled();
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query })).total).toBe(1);
    expect((await loadImageGenerationRun({ store, sessionId: session.id, runId: run.id }))?.execution.type).toBe('running');
  });
  it.each(['seed', 'width', 'height', 'index'] as const)('rejects an output with wrong %s before writing its bytes', async field => {
    const { store, run } = await start({ count: 1 }); const asset = generationAssetFixture({ id: 'asset-eF', run, index: 0 });
    switch (field) {
    case 'seed': asset.seed = '43'; break;
    case 'index': asset.index = 1; break;
    case 'width': asset.result.width = 512; break;
    case 'height': asset.result.height = 512; break;
    default: { const exhaustive: never = field; throw new Error(String(exhaustive)); }
    }
    const writeImages = vi.fn(); await expect(commitImageGenerationAsset({ store, asset, writeImages })).rejects.toThrow('accepted plan');
    expect(writeImages).not.toHaveBeenCalled();
  });
  it('completes only after every planned output has been committed', async () => {
    const { store, session, run } = await start({ count: 2 });
    const request = { store, sessionId: session.id, runId: run.id, execution: { type: 'completed' as const, finishedAt: 50 }, expectedRevision: 1 };
    const first = generationAssetFixture({ id: 'first-eF', run, index: 0 });
    await commitImageGenerationAsset({ store, asset: first, writeImages: async () => {} });
    await expect(updateImageGenerationRunExecution(request)).rejects.toThrow('all planned outputs');
    await commitImageGenerationAsset({ store, asset: generationAssetFixture({ id: 'second-eF', run, index: 1 }), writeImages: async () => {} });
    await updateImageGenerationRunExecution(request); await updateImageGenerationRunExecution(request);
    expect((await loadImageGenerationRun({ store, sessionId: session.id, runId: run.id }))?.execution.type).toBe('completed');
    await commitImageGenerationAsset({ store, asset: first, writeImages: async () => {} });
    await expect(updateImageGenerationRunExecution({ ...request, expectedRevision: 2, execution: { type: 'running', startedAt: 100 } })).rejects.toThrow('transition');
  });
  it.each(['cancelled', 'failed', 'interrupted'] as const)('retains partial outputs after %s without adding new ones', async type => {
    const { store, session, run } = await start({ count: 2 });
    await commitImageGenerationAsset({ store, asset: generationAssetFixture({ id: 'first-eF', run, index: 0 }), writeImages: async () => {} });
    const execution = type === 'failed' ? { type, finishedAt: 20, message: 'test failure' } : { type, finishedAt: 20 };
    await updateImageGenerationRunExecution({ store, sessionId: session.id, runId: run.id, execution, expectedRevision: 1 });
    await expect(commitImageGenerationAsset({ store, asset: generationAssetFixture({ id: 'late-eF', run, index: 1 }), writeImages: async () => {} })).rejects.toThrow('Only running');
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query })).total).toBe(1);
  });
  it('continues publishing into the captured session after another session becomes the UI selection', async () => {
    const { store, session, run } = await start({ count: 1 }); const other = generationSessionFixture({ id: 'other-aB' });
    await saveImageGenerationSession({ store, session: other, expectedRevision: undefined });
    await commitImageGenerationAsset({ store, asset: generationAssetFixture({ id: 'first-eF', run, index: 0 }), writeImages: async () => {} });
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query })).total).toBe(1);
    expect((await queryImageGenerationAssets({ store, sessionId: other.id, query })).total).toBe(0);
  });
  it('prevents new runs in an archived session but keeps an in-flight output', async () => {
    const { store, session, run } = await start({ count: 1 });
    await saveImageGenerationSession({ store, session: { ...session, revision: 1, state: 'archived' }, expectedRevision: 0 });
    const extra = generationRunFixture({ id: 'extra-cD', sessionId: session.id, count: 1, seed: '42' });
    await expect(createImageGenerationRun({ store, run: extra, writeInputs: async () => {} })).rejects.toThrow('archived');
    await commitImageGenerationAsset({ store, asset: generationAssetFixture({ id: 'first-eF', run, index: 0 }), writeImages: async () => {} });
  });
  it('records real cross-session lineage without using the source session as the owner', async () => {
    const { store, session, asset } = await published(); const other = generationSessionFixture({ id: 'other-aB' });
    await saveImageGenerationSession({ store, session: other, expectedRevision: undefined });
    const run = generationRunFixture({ id: 'other-cD', sessionId: other.id, count: 1, seed: '99' });
    run.sources = [{ role: 'settings', sessionId: session.id, assetId: asset.id }];
    await createImageGenerationRun({ store, run, writeInputs: async () => {} });
    expect((await loadImageGenerationRun({ store, sessionId: other.id, runId: run.id }))?.sources).toEqual(run.sources);
    expect((await loadImageGenerationRun({ store, sessionId: session.id, runId: run.id }))).toBeUndefined();
  });
  it('never interprets a locally absent worker as an interrupted run', async () => {
    const { store, session, run } = await start({ count: 1 });
    await listImageGenerationRuns({ store, sessionId: session.id });
    expect((await loadImageGenerationRun({ store, sessionId: session.id, runId: run.id }))?.execution.type).toBe('running');
  });
});

describe('curation and Unicode tag rename', () => {
  it('uses the same system-tag assignment for favorite toggling and filtering', async () => {
    const { store, session, asset } = await published();
    expect((await loadImageGenerationAssetAnnotations({ store, sessionId: session.id, assetId: asset.id }))?.tags).toEqual([]);
    await setImageGenerationAssetTags({ store, sessionId: session.id, assetId: asset.id, tags: [favorite], assignedAt: 20, expectedRevision: 0 });
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query: { ...query, tags: [favorite] } })).items.map(item => item.id)).toEqual([asset.id]);
    await setImageGenerationAssetTags({ store, sessionId: session.id, assetId: asset.id, tags: [], assignedAt: 30, expectedRevision: 1 });
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query: { ...query, tags: [favorite] } })).total).toBe(0);
  });
  it('renames a Japanese tag in the catalog without rewriting runs, assets or assignments', async () => {
    const { store, catalog, session, asset } = await published();
    const tagId = toImageGenerationTagId({ raw: 'tag-ab' });
    const tagged = { ...catalog, revision: 1, tags: [{ id: tagId, name: '雨夜景', state: 'active' as const, createdAt: 1, updatedAt: 1 }] };
    await saveImageGenerationCatalog({ store, catalog: tagged, expectedRevision: 0 });
    const tags: ImageGenerationTagReference[] = [favorite, { type: 'user', tagId }];
    await setImageGenerationAssetTags({ store, sessionId: session.id, assetId: asset.id, tags, assignedAt: 20, expectedRevision: 0 });
    const before = await loadImageGenerationAssetAnnotations({ store, sessionId: session.id, assetId: asset.id });
    h.writes.length = 0;
    await saveImageGenerationCatalog({ store, catalog: { ...tagged, revision: 2, tags: tagged.tags.map(tag => ({ ...tag, name: '背景候補🟦', updatedAt: 30 })) }, expectedRevision: 1 });
    expect(h.writes).toEqual([`${rootPath}/catalog.json`]);
    expect(await loadImageGenerationAssetAnnotations({ store, sessionId: session.id, assetId: asset.id })).toEqual(before);
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query: { ...query, tags } })).total).toBe(1);
  });
  it('keeps assignment times for retained tags and gives a re-added tag a new time', async () => {
    const { store, session, asset } = await published();
    const base = { store, sessionId: session.id, assetId: asset.id };
    await setImageGenerationAssetTags({ ...base, tags: [favorite], assignedAt: 20, expectedRevision: 0 });
    await setImageGenerationAssetTags({ ...base, tags: [favorite], assignedAt: 30, expectedRevision: 1 });
    expect((await loadImageGenerationAssetAnnotations(base))?.tags[0]?.assignedAt).toBe(20);
    await setImageGenerationAssetTags({ ...base, tags: [], assignedAt: 40, expectedRevision: 2 });
    await setImageGenerationAssetTags({ ...base, tags: [favorite], assignedAt: 50, expectedRevision: 3 });
    expect((await loadImageGenerationAssetAnnotations(base))?.tags[0]?.assignedAt).toBe(50);
  });
  it('does not silently overwrite another tab\'s curation', async () => {
    const { store, session, asset } = await published(); const base = { store, sessionId: session.id, assetId: asset.id };
    await setImageGenerationAssetTags({ ...base, tags: [favorite], assignedAt: 20, expectedRevision: 0 });
    await expect(setImageGenerationAssetTags({ ...base, tags: [], assignedAt: 30, expectedRevision: 0 })).rejects.toThrow('conflict');
    await setImageGenerationAssetTags({ ...base, tags: [favorite], assignedAt: 20, expectedRevision: 0 });
    expect((await loadImageGenerationAssetAnnotations(base))?.revision).toBe(1);
  });
  it('rejects unknown and duplicate tag assignments', async () => {
    const { store, session, asset } = await published(); const base = { store, sessionId: session.id, assetId: asset.id, assignedAt: 20, expectedRevision: 0 };
    await expect(setImageGenerationAssetTags({ ...base, tags: [{ type: 'user', tagId: toImageGenerationTagId({ raw: 'missing-tag' }) }] })).rejects.toThrow('unknown');
    await expect(setImageGenerationAssetTags({ ...base, tags: [favorite, favorite] })).rejects.toThrow('Duplicate');
  });
  it('archives tag definitions without erasing historical assignments', async () => {
    const { store, catalog, session, asset } = await published(); const tagId = toImageGenerationTagId({ raw: 'tag-ab' });
    const tagged = { ...catalog, revision: 1, tags: [{ id: tagId, name: '候補', state: 'active' as const, createdAt: 1, updatedAt: 1 }] };
    const tag: ImageGenerationTagReference = { type: 'user', tagId };
    await saveImageGenerationCatalog({ store, catalog: tagged, expectedRevision: 0 });
    const base = { store, sessionId: session.id, assetId: asset.id };
    await setImageGenerationAssetTags({ ...base, tags: [tag], assignedAt: 20, expectedRevision: 0 });
    await saveImageGenerationCatalog({ store, catalog: { ...tagged, revision: 2, tags: tagged.tags.map(tag => ({ ...tag, state: 'archived' })) }, expectedRevision: 1 });
    await setImageGenerationAssetTags({ ...base, tags: [tag, favorite], assignedAt: 30, expectedRevision: 1 });
    expect((await loadImageGenerationAssetAnnotations(base))?.tags[0]?.assignedAt).toBe(20);
    await setImageGenerationAssetTags({ ...base, tags: [], assignedAt: 40, expectedRevision: 2 });
    await expect(setImageGenerationAssetTags({ ...base, tags: [tag], assignedAt: 50, expectedRevision: 3 })).rejects.toThrow('archived');
    const current = await loadImageGenerationCatalog({ store });
    await expect(saveImageGenerationCatalog({ store, catalog: { ...current, revision: 3, tags: [] }, expectedRevision: 2 })).rejects.toThrow('Archive tags');
  });
});

describe('failure recovery and indexed reads', () => {
  it('recovers a title update when its canonical record committed but the index failed', async () => {
    const { store, session } = await start({ count: 1 });
    const indexPath = `${rootPath}/sessions/ab/index.json`;
    h.faults.add(`close:${indexPath}`);
    const next = { ...session, title: '更新された名前', revision: 1, updatedAt: 99 };
    await expect(saveImageGenerationSession({ store, session: next, expectedRevision: 0 })).rejects.toThrow('Injected');
    expect((await h.file({ path: indexPath })).text).toContain('雨の夜景');
    const result = await listImageGenerationSessions({ store });
    expect(result.items[0]?.title).toBe(next.title);
    await saveImageGenerationSession({ store, session: next, expectedRevision: 0 });
    expect((await h.file({ path: indexPath })).text).toContain(next.title);
    expect((await h.directory({ path: `${rootPath}/sessions/ab` })).children.has('index.dirty')).toBe(false);
  });
  it('recovers favorite updates even when filenames did not change', async () => {
    const { store, session, asset } = await published();
    const base = { store, sessionId: session.id, assetId: asset.id };
    await setImageGenerationAssetTags({ ...base, tags: [], assignedAt: 10, expectedRevision: 0 });
    const path = `${sessionPath({ id: session.id })}/annotations/ef/index.json`;
    h.faults.add(`close:${path}`);
    await expect(setImageGenerationAssetTags({ ...base, tags: [favorite], assignedAt: 20, expectedRevision: 1 })).rejects.toThrow('Injected');
    expect((await h.file({ path })).text).not.toContain('favorite');
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query: { ...query, tags: [favorite] } })).total).toBe(1);
    await setImageGenerationAssetTags({ ...base, tags: [favorite], assignedAt: 20, expectedRevision: 1 });
    expect((await h.file({ path })).text).toContain('favorite');
  });
  it('keeps the original record when its replacement cannot close', async () => {
    const { store, session } = await start({ count: 1 }); const path = `${sessionPath({ id: session.id })}/session.json`;
    const before = (await h.file({ path })).text; h.faults.add(`close:${path}`);
    await expect(saveImageGenerationSession({ store, session: { ...session, revision: 1, title: 'failed edit' }, expectedRevision: 0 })).rejects.toThrow('Injected');
    expect((await h.file({ path })).text).toBe(before);
    expect((await listImageGenerationSessions({ store })).items[0]?.title).toBe(session.title);
  });
  it('retains readable records with warnings and leaves corrupt indexes untouched', async () => {
    const { store, session } = await start({ count: 1 }); const path = `${rootPath}/sessions/ab/index.json`;
    const index = await h.file({ path }); index.text = '{bad';
    const result = await listImageGenerationSessions({ store });
    expect(result.items.map(item => item.id)).toEqual([session.id]); expect(result.warningCount).toBeGreaterThan(0);
    await expect(saveImageGenerationSession({ store, session: { ...session, revision: 1, title: 'blocked' }, expectedRevision: 0 })).rejects.toThrow();
    expect(index.text).toBe('{bad');
  });
  it('does not turn an unreadable annotation file into a claimed empty tag set', async () => {
    const { store, session, asset } = await published(); const base = { store, sessionId: session.id, assetId: asset.id };
    await setImageGenerationAssetTags({ ...base, tags: [favorite], assignedAt: 20, expectedRevision: 0 });
    const directory = await h.directory({ path: `${sessionPath({ id: session.id })}/annotations/ef` });
    (await directory.getFileHandle('index.json')).text = '{bad'; (await directory.getFileHandle('asset-eF.json')).text = '';
    const result = await queryImageGenerationAssets({ store, sessionId: session.id, query });
    expect(result.warningCount).toBeGreaterThan(0); expect(result.items[0]?.annotations).toBeUndefined();
    await expect(setImageGenerationAssetTags({ ...base, tags: [], assignedAt: 30, expectedRevision: 1 })).rejects.toThrow();
    expect((await directory.getFileHandle('asset-eF.json')).text).toBe('');
  });
  it('does not rewrite unknown request fields while changing execution state', async () => {
    const { store, session, run } = await start({ count: 1 });
    const path = `${sessionPath({ id: session.id })}/runs/cd/run-cD.json`;
    const file = await h.file({ path });
    // Preserve the actual persisted representation and inject an unknown field
    // without importing the storage DTO/mapper across the feature boundary.
    const text = file.text.replace('"parameters":{', '"parameters":{"future_setting":true,');
    expect(text).not.toBe(file.text);
    file.text = text;
    await expect(updateImageGenerationRunExecution({ store, sessionId: session.id, runId: run.id, execution: { type: 'failed', finishedAt: 20, message: 'no' }, expectedRevision: 0 })).rejects.toThrow();
    expect(file.text).toBe(text);
  });
  it('reads healthy listing indexes without loading full requests or asset records', async () => {
    const { store, session } = await published(); h.reads.length = 0;
    await queryImageGenerationAssets({ store, sessionId: session.id, query });
    expect(h.reads.some(path => path.endsWith('/run-cD.json') || path.endsWith('/asset-eF.json'))).toBe(false);
  });
  it('uses a stable keyset cursor when a newer image is inserted between pages', async () => {
    const { store, session, run } = await start({ count: 4 });
    for (const index of [0, 1, 2]) await commitImageGenerationAsset({ store, asset: generationAssetFixture({ id: `asset-${index}-eF`, run, index }), writeImages: async () => {} });
    const first = await queryImageGenerationAssets({ store, sessionId: session.id, query: { ...query, limit: 2 } });
    expect(first.items.map(item => item.index)).toEqual([2, 1]);
    await commitImageGenerationAsset({ store, asset: generationAssetFixture({ id: 'asset-3-eF', run, index: 3 }), writeImages: async () => {} });
    const second = await queryImageGenerationAssets({ store, sessionId: session.id, query: { ...query, cursor: first.nextCursor, limit: 2 } });
    expect(second.items.map(item => item.index)).toEqual([0]); expect(second.nextCursor).toBeUndefined();
  });
  it('supports all/any tag matching without matching user tag names as identities', async () => {
    const { store, session } = await published();
    const nonexistent: ImageGenerationTagReference = { type: 'user', tagId: toImageGenerationTagId({ raw: 'favorite' }) };
    const page = await queryImageGenerationAssets({ store, sessionId: session.id, query }); const id = page.items[0]!.id;
    await setImageGenerationAssetTags({ store, sessionId: session.id, assetId: id, tags: [favorite], assignedAt: 20, expectedRevision: 0 });
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query: { ...query, tags: [favorite, nonexistent], match: 'all' } })).total).toBe(0);
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query: { ...query, tags: [favorite, nonexistent], match: 'any' } })).total).toBe(1);
    expect((await queryImageGenerationAssets({ store, sessionId: session.id, query: { ...query, text: '雨夜景 MAIN.GGUF' } })).total).toBe(1);
  });
});

describe('additional publication boundary failures', () => {
  it.each(['open', 'write', 'close'])('can retry a new session after a known %s failure without an empty directory poisoning the shard', async operation => {
    const { store } = await createStore(); const session = generationSessionFixture({ id: 'session-aB' });
    h.faults.add(`${operation}:${sessionPath({ id: session.id })}/session.json`);
    await expect(saveImageGenerationSession({ store, session, expectedRevision: undefined })).rejects.toThrow('Injected');
    expect((await listImageGenerationSessions({ store })).items).toHaveLength(0);
    await saveImageGenerationSession({ store, session, expectedRevision: undefined });
    expect(await loadImageGenerationSession({ store, sessionId: session.id })).toEqual({ ...session, activityOrder: expect.any(Number) });
  });
  it('does not lose a committed title when removing the dirty marker fails', async () => {
    const { store, session } = await start({ count: 1 });
    h.faults.add(`remove:${rootPath}/sessions/ab/index.dirty`);
    const next = { ...session, revision: 1, title: 'committed before acknowledgement' };
    await expect(saveImageGenerationSession({ store, session: next, expectedRevision: 0 })).rejects.toThrow('Injected');
    expect((await listImageGenerationSessions({ store })).items[0]?.title).toBe(next.title);
    await saveImageGenerationSession({ store, session: next, expectedRevision: 0 });
    expect((await listImageGenerationSessions({ store })).warningCount).toBe(0);
  });
  it('does not commit a record when writing its dirty marker fails', async () => {
    const { store, session } = await start({ count: 1 });
    h.faults.add(`close:${rootPath}/sessions/ab/index.dirty`);
    await expect(saveImageGenerationSession({ store, session: { ...session, revision: 1, title: 'uncommitted' }, expectedRevision: 0 })).rejects.toThrow('Injected');
    expect((await loadImageGenerationSession({ store, sessionId: session.id }))?.title).toBe(session.title);
  });
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('validates assignment time even when clearing tags: %s', async assignedAt => {
    const { store, session, asset } = await published(); h.writes.length = 0;
    await expect(setImageGenerationAssetTags({ store, sessionId: session.id, assetId: asset.id, tags: [], assignedAt, expectedRevision: 0 })).rejects.toThrow();
    expect(h.writes).toEqual([]);
  });
  it.each(['', ' ', '　'])('rejects blank session titles before storage: %j', async title => {
    const { store } = await createStore(); h.getDirectory.mockClear();
    await expect(saveImageGenerationSession({ store, session: { ...generationSessionFixture({ id: 'session-aB' }), title }, expectedRevision: undefined })).rejects.toThrow();
    expect(h.getDirectory).not.toHaveBeenCalled();
  });
  it('does not report an exact empty listing when directory enumeration fails', async () => {
    const { store, session } = await published();
    h.faults.add(`enumerate:${sessionPath({ id: session.id })}/assets`);
    await expect(queryImageGenerationAssets({ store, sessionId: session.id, query })).rejects.toThrow('Injected');
  });
});

describe('image-input lineage integrity', () => {
  it.each(['initial-image', 'reference-image'] as const)('rejects a %s edge without matching input bytes', async role => {
    const { store, session, asset } = await published();
    const run = generationRunFixture({ id: 'derived-cD', sessionId: session.id, count: 1, seed: '42' });
    run.sources = [{ role, sessionId: session.id, assetId: asset.id }];
    const writeInputs = vi.fn();
    await expect(createImageGenerationRun({ store, run, writeInputs })).rejects.toThrow('Lineage does not match');
    expect(writeInputs).not.toHaveBeenCalled();
  });
  it.each(['initial-image', 'reference-image'] as const)('accepts a %s edge when it describes the actual input', async role => {
    const { store, session, asset } = await published();
    const run = generationRunFixture({ id: 'derived-cD', sessionId: session.id, count: 1, seed: '42' });
    run.sources = [{ role, sessionId: session.id, assetId: asset.id }];
    const input = { binaryObjectId: asset.result.binaryObjectId, name: 'source.png' };
    if (role === 'initial-image') run.request.imageInputs.initImage = input;
    else run.request.imageInputs.referenceImages = [input];
    await createImageGenerationRun({ store, run, writeInputs: async () => {} });
    expect((await loadImageGenerationRun({ store, sessionId: session.id, runId: run.id }))?.sources).toEqual(run.sources);
  });
  it('allows a stored preview as an explicitly selected input without claiming it is the final output', async () => {
    const { store, session, asset } = await published();
    const run = generationRunFixture({ id: 'derived-cD', sessionId: session.id, count: 1, seed: '42' });
    run.sources = [{ role: 'initial-image', sessionId: session.id, assetId: asset.id }];
    const preview = asset.previews[0]!;
    run.request.imageInputs.initImage = { binaryObjectId: preview.binaryObjectId, name: 'preview.png' };
    await createImageGenerationRun({ store, run, writeInputs: async () => {} });
    expect((await loadImageGenerationRun({ store, sessionId: session.id, runId: run.id }))?.request.imageInputs.initImage?.binaryObjectId).toBe(preview.binaryObjectId);
  });
});

describe('preserving incomplete creation evidence', () => {
  it('does not recursively delete a new session whose incomplete file could not be removed', async () => {
    const { store } = await createStore(); const session = generationSessionFixture({ id: 'session-aB' });
    const path = `${sessionPath({ id: session.id })}/session.json`;
    h.faults.add(`close:${path}`); h.faults.add(`remove:${path}`);
    await expect(saveImageGenerationSession({ store, session, expectedRevision: undefined })).rejects.toThrow('Injected');
    const file = await h.file({ path }); expect(file.text).toBe('');
    const page = await listImageGenerationSessions({ store });
    expect(page.warningCount).toBeGreaterThan(0);
    await expect(saveImageGenerationSession({ store, session, expectedRevision: undefined })).rejects.toThrow();
    expect((await h.file({ path })).text).toBe('');
  });
});
