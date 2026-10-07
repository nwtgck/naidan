import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toImageGenerationSessionId } from '@/01-models/ids';
import { ExperimentalImageGenerationCatalogSchemaDto, ExperimentalImageGenerationSessionSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationCatalogToDomain, imageGenerationCatalogToDto, imageGenerationSessionToDomain, imageGenerationSessionToDto } from '@/00-storage/mapper/image-generation';
import { createImageGenerationStorageHarness, generationSessionFixture, generationRunFixture, generationDraftFixture } from './image-generation/test-support';
import * as service from './image-generation';
let fs: ReturnType<typeof createImageGenerationStorageHarness>;
const root = '/naidan-storage/experimental/image-generation';
beforeEach(() => {
  fs = createImageGenerationStorageHarness(); vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function setup() {
  const catalog = await service.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' });
  if (!catalog) throw new Error('Missing catalog.');
  const store = { storeId: catalog.id, storageType: 'opfs' as const };
  const session = generationSessionFixture({ id: 'session-aa' });
  await service.saveImageGenerationSession({ store, session, expectedRevision: undefined });
  const draft = generationDraftFixture({ sessionId: session.id });
  await service.saveImageGenerationDraft({ store, draft, expectedRevision: undefined, writeInputs: async () => {} });
  return { store, session, catalog, draft };
}
describe('image generation session deletion', () => {
  it('removes session-owned metadata but keeps binary data, other sessions and a minimal tombstone', async () => {
    const h = await setup();
    const other = generationSessionFixture({ id: 'session-bb' });
    await service.saveImageGenerationSession({ store: h.store, session: other, expectedRevision: undefined });
    const binaries = await fs.root.getDirectoryHandle('binary-objects', { create: true });
    const file = await binaries.getFileHandle('shared-image.bin', { create: true }); file.text = 'image bytes';
    await service.deleteImageGenerationSession({ store: h.store, sessionId: h.session.id, expectedRevision: 0 });
    expect(await service.loadImageGenerationSession({ store: h.store, sessionId: h.session.id })).toBeUndefined();
    expect((await service.listImageGenerationSessions({ store: h.store })).items.map(session => session.id)).toEqual([other.id]);
    const directory = await fs.directory({ path: `${root}/sessions/aa/session-aa` });
    expect([...directory.children.keys()]).toEqual(['session.json']);
    const marker = await fs.file({ path: `${root}/sessions/aa/session-aa/session.json` });
    expect(JSON.parse(marker.text)).toMatchObject({ state: 'deleted', title: 'Deleted session' });
    expect(file.text).toBe('image bytes');
    const writes = fs.writes.length;
    await service.deleteImageGenerationSession({ store: h.store, sessionId: h.session.id, expectedRevision: 0 });
    expect(fs.writes.length).toBe(writes);
  });
  it('rejects a stale deletion before touching the session or files', async () => {
    const h = await setup();
    await service.saveImageGenerationSession({ store: h.store, session: { ...h.session, revision: 1, title: 'renamed' }, expectedRevision: 0 });
    await expect(service.deleteImageGenerationSession({ store: h.store, sessionId: h.session.id, expectedRevision: 0 })).rejects.toThrow('conflict');
    expect((await service.loadImageGenerationSession({ store: h.store, sessionId: h.session.id }))?.title).toBe('renamed');
    expect(await service.loadImageGenerationDraft({ store: h.store, sessionId: h.session.id })).toBeTruthy();
  });
  it('keeps interrupted cleanup discoverable, rejects ordinary writes and permits retry after reload', async () => {
    const h = await setup();
    fs.faults.add(`remove:${root}/sessions/aa/session-aa/draft.json`);
    await expect(service.deleteImageGenerationSession({ store: h.store, sessionId: h.session.id, expectedRevision: 0 })).rejects.toThrow('Injected');
    const pending = (await service.listImageGenerationSessions({ store: h.store })).items[0]!;
    expect(pending.state).toBe('deleting'); expect(pending.title).toBe(h.session.title);
    await expect(service.saveImageGenerationSession({ store: h.store, session: { ...h.session, revision: 2 }, expectedRevision: 1 })).rejects.toThrow('deleted');
    const writeInputs = vi.fn(async () => {});
    await expect(service.saveImageGenerationDraft({ store: h.store, draft: { ...h.draft, revision: 1 }, expectedRevision: 0, writeInputs })).rejects.toThrow();
    expect(writeInputs).not.toHaveBeenCalled();
    await service.deleteImageGenerationSession({ store: h.store, sessionId: h.session.id, expectedRevision: pending.revision });
    expect((await service.listImageGenerationSessions({ store: h.store })).items).toEqual([]);
  });
  it('does not republish a delayed run or reuse the deleted ID', async () => {
    const h = await setup();
    await service.deleteImageGenerationSession({ store: h.store, sessionId: h.session.id, expectedRevision: 0 });
    const writeInputs = vi.fn(async () => {});
    await expect(service.createImageGenerationRun({ store: h.store, run: generationRunFixture({ id: 'run-aa', sessionId: h.session.id, count: 1, seed: '42' }), writeInputs })).rejects.toThrow();
    await expect(service.saveImageGenerationSession({ store: h.store, session: h.session, expectedRevision: undefined })).rejects.toThrow('deleted');
    expect(writeInputs).not.toHaveBeenCalled();
  });
  it('cannot traverse outside the session directory', async () => {
    const h = await setup();
    await expect(service.deleteImageGenerationSession({ store: h.store, sessionId: toImageGenerationSessionId({ raw: '../binary-objects' }), expectedRevision: 0 })).rejects.toThrow();
    expect((await service.listImageGenerationSessions({ store: h.store })).items).toHaveLength(1);
  });
});
describe('experimental translation and visibility persistence', () => {
  it('round-trips independent workspace and session overrides including private headers and open/closed visibility', async () => {
    const h = await setup();
    const translation = { endpoint: { type: 'openai' as const, url: 'https://translator.test/v1', httpHeaders: [['Authorization', 'secret']] as [string, string][] }, modelId: 'model-a', lmParameters: undefined };
    const next = { ...h.catalog, revision: 1, preferences: { ...h.catalog.preferences, assistantVisibility: 'open' as const, translation } };
    const dto = ExperimentalImageGenerationCatalogSchemaDto.parse(imageGenerationCatalogToDto({ catalog: next }));
    expect(imageGenerationCatalogToDomain({ dto })).toEqual(next);
    await service.saveImageGenerationCatalog({ store: h.store, catalog: next, expectedRevision: 0 });
    expect(await service.loadImageGenerationCatalog({ store: h.store })).toEqual(next);
    const session = { ...h.session, revision: 1, translation: { endpoint: undefined, modelId: 'session-model', lmParameters: undefined } };
    expect(imageGenerationSessionToDomain({ dto: ExperimentalImageGenerationSessionSchemaDto.parse(imageGenerationSessionToDto({ session })) })).toEqual(session);
    await service.saveImageGenerationSession({ store: h.store, session, expectedRevision: 0 });
    expect((await service.loadImageGenerationSession({ store: h.store, sessionId: session.id }))?.translation?.modelId).toBe('session-model');
  });
  it('defaults old visibility to closed rather than reopening a docked chat', async () => {
    const h = await setup();
    const encoded = imageGenerationCatalogToDto({ catalog: h.catalog });
    const raw = { ...encoded, preferences: { assistantLayout: 'docked', experimentalNoticeDismissedAt: undefined } };
    const decoded = imageGenerationCatalogToDomain({ dto: ExperimentalImageGenerationCatalogSchemaDto.parse(raw) });
    expect(decoded.preferences.assistantVisibility).toBe('closed'); expect(decoded.preferences.translation).toBeUndefined();
  });
  it('rejects unknown override fields instead of erasing them during a preference edit', async () => {
    const h = await setup();
    const dto = imageGenerationCatalogToDto({ catalog: h.catalog });
    expect(ExperimentalImageGenerationCatalogSchemaDto.safeParse({ ...dto, preferences: { ...dto.preferences, translation: { modelId: 'x', future: true } } }).success).toBe(false);
  });
});

describe('accepted session activity and translation parameters', () => {
  it('moves an accepted session, preserves concurrent metadata and uses the original timestamp on retry', async () => {
    const h = await setup();
    const other = { ...generationSessionFixture({ id: 'session-bb' }), updatedAt: 10 };
    await service.saveImageGenerationSession({ store: h.store, session: other, expectedRevision: undefined });
    const run = { ...generationRunFixture({ id: 'run-aa', sessionId: h.session.id, count: 1, seed: '42' }), createdAt: 20 };
    await expect(service.recordImageGenerationSessionUse({ store: h.store, sessionId: h.session.id, runId: run.id })).rejects.toThrow('accepted');
    await service.createImageGenerationRun({ store: h.store, run, writeInputs: async () => {} });
    await service.saveImageGenerationSession({ store: h.store, session: { ...h.session, revision: 1, title: 'concurrent rename', updatedAt: 25 }, expectedRevision: 0 });
    const updated = await service.recordImageGenerationSessionUse({ store: h.store, sessionId: h.session.id, runId: run.id });
    expect(updated).toMatchObject({ updatedAt: 25, title: 'concurrent rename', revision: 1 });
    expect((await service.listImageGenerationSessions({ store: h.store })).items[0]?.id).toBe(h.session.id);
    await service.saveImageGenerationSession({ store: h.store, session: { ...other, revision: 1, updatedAt: 30 }, expectedRevision: 0 });
    const writes = fs.writes.length;
    await service.recordImageGenerationSessionUse({ store: h.store, sessionId: h.session.id, runId: run.id });
    expect(fs.writes.length).toBe(writes);
    expect((await service.listImageGenerationSessions({ store: h.store })).items[0]?.id).toBe(other.id);
    await service.deleteImageGenerationSession({ store: h.store, sessionId: h.session.id, expectedRevision: updated.revision });
    await expect(service.recordImageGenerationSessionUse({ store: h.store, sessionId: h.session.id, runId: run.id })).rejects.toThrow();
  });
  it('round trips explicit zero, empty stop and reasoning off while rejecting nested unknown data', async () => {
    const h = await setup(); const dto = imageGenerationCatalogToDto({ catalog: h.catalog });
    const preferences = { ...dto.preferences, translation: { lmParameters: { temperature: 0, stop: [], reasoning: { effort: 'none' } } }, generationMonitorPresentation: 'compact-progress' };
    const decoded = imageGenerationCatalogToDomain({ dto: ExperimentalImageGenerationCatalogSchemaDto.parse({ ...dto, preferences }) });
    expect(decoded.preferences.translation?.lmParameters).toMatchObject({ temperature: 0, stop: [], reasoning: { effort: 'none' } });
    expect(decoded.preferences.generationMonitorPresentation).toBe('compact-progress');
    for (const lmParameters of [{ future: 1 }, { reasoning: { future: true } }, { reasoning: { effort: 'future' } }]) {
      expect(ExperimentalImageGenerationCatalogSchemaDto.safeParse({ ...dto, preferences: { ...preferences, translation: { lmParameters } } }).success).toBe(false);
    }
    expect(ExperimentalImageGenerationCatalogSchemaDto.safeParse({ ...dto, preferences: { ...preferences, generationMonitorPresentation: 'future' } }).success).toBe(false);
  });
});
