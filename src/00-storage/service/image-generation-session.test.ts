import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toImageGenerationRunId, toImageGenerationSessionId } from '@/01-models/ids';
import { ExperimentalImageGenerationCatalogSchemaDto, ExperimentalImageGenerationSessionSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { imageGenerationCatalogToDomain, imageGenerationCatalogToDto, imageGenerationSessionToDomain, imageGenerationSessionToDto } from '@/00-storage/mapper/image-generation';
import { createImageGenerationStorageHarness, generationSessionFixture, generationRunFixture, generationDraftFixture } from './image-generation/test-support';
import * as service from './image-generation';
import { collectImageGenerationSessionMetadata } from './image-generation-export';
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

  it('accepts future override fields and preserves known preferences when editing', async () => {
    const h = await setup();
    const dto = imageGenerationCatalogToDto({ catalog: h.catalog });
    const parsed = ExperimentalImageGenerationCatalogSchemaDto.parse({ ...dto, preferences: { ...dto.preferences, translation: { modelId: 'x', future: true } } });
    expect(parsed.preferences.translation?.modelId).toBe('x');
    expect(parsed.preferences.translation).not.toHaveProperty('future');
    expect(ExperimentalImageGenerationCatalogSchemaDto.parse(parsed)).toEqual(parsed);
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

  it('round trips explicit zero, empty stop and reasoning off while accepting unknown fields but rejecting unknown enum values', async () => {
    const h = await setup(); const dto = imageGenerationCatalogToDto({ catalog: h.catalog });
    const preferences = { ...dto.preferences, translation: { lmParameters: { temperature: 0, stop: [], reasoning: { effort: 'none' } } }, generationMonitorPresentation: 'compact-progress' };
    const decoded = imageGenerationCatalogToDomain({ dto: ExperimentalImageGenerationCatalogSchemaDto.parse({ ...dto, preferences }) });
    expect(decoded.preferences.translation?.lmParameters).toMatchObject({ temperature: 0, stop: [], reasoning: { effort: 'none' } });
    expect(decoded.preferences.generationMonitorPresentation).toBe('compact-progress');
    for (const lmParameters of [{ future: 1 }, { reasoning: { future: true } }, { experimental: { future: 1 } }]) {
      const parsed = ExperimentalImageGenerationCatalogSchemaDto.parse({ ...dto, preferences: { ...preferences, translation: { lmParameters } } });
      expect(ExperimentalImageGenerationCatalogSchemaDto.parse(parsed)).toEqual(parsed);
    }
    expect(ExperimentalImageGenerationCatalogSchemaDto.safeParse({ ...dto, preferences: { ...preferences, translation: { lmParameters: { reasoning: { effort: 'future' } } } } }).success).toBe(false);
    expect(ExperimentalImageGenerationCatalogSchemaDto.safeParse({ ...dto, preferences: { ...preferences, generationMonitorPresentation: 'future' } }).success).toBe(false);
  });
});

it.each(['missing', 'stale', 'dirty'] as const)('preserves unavailable RPC siblings while rebuilding a %s run index', async state => {
  const h = await setup();
  const local = generationRunFixture({ id: 'local-aa', sessionId: h.session.id, count: 1, seed: '42' });
  await service.createImageGenerationRun({ store: h.store, run: local, writeInputs: async () => {} });
  const path = `${root}/sessions/aa/session-aa/runs/aa`, directory = await fs.directory({ path });
  const raw = JSON.parse((await fs.file({ path: `${path}/local-aa.json` })).text);
  raw.id = 'remote-aa'; raw.request.runtime = { profile: 'naidan-rpc', registrationId: 'old-registration', peerId: 'B'.repeat(43), label: 'Unavailable' };
  const remote = await directory.getFileHandle('remote-aa.json', { create: true }); remote.text = JSON.stringify(raw);
  const preserved = remote.text;
  if (state === 'missing') await directory.removeEntry('index.json');
  else {
    const index = await directory.getFileHandle('index.json');
    const value = JSON.parse(index.text); value.items.push({ ...value.items[0], id: 'remote-aa' }); index.text = JSON.stringify(value);
    if (state === 'dirty') (await directory.getFileHandle('index.dirty', { create: true })).text = 'interrupted';
  }
  const activity = await fs.file({ path: `${root}/session-activity.json` });
  const sequence = JSON.parse(activity.text).sequence;
  for (const id of ['next-aa', 'later-aa']) {
    await service.createImageGenerationRun({ store: h.store, run: generationRunFixture({ id, sessionId: h.session.id, count: 1, seed: '42' }), writeInputs: async () => {} });
    expect(remote.text).toBe(preserved);
  }
  const listed = await service.listImageGenerationRuns({ store: h.store, sessionId: h.session.id });
  expect(listed.items).toHaveLength(3); expect(listed.warningCount).toBe(1);
  expect(directory.children.has('remote-aa.json')).toBe(true);
  expect(JSON.parse(activity.text).sequence).toBe(sequence + 2);
  expect(JSON.parse((await fs.file({ path: `${path}/next-aa.json` })).text).acceptedOrder).toBe(sequence + 1);
  expect(JSON.parse((await fs.file({ path: `${path}/later-aa.json` })).text).acceptedOrder).toBe(sequence + 2);
});

it('uses a cold stale RPC summary only for presentation and rejects canonical actions without changing bytes', async () => {
  const h = await setup();
  const local = generationRunFixture({ id: 'local-aa', sessionId: h.session.id, count: 1, seed: '42' });
  await service.createImageGenerationRun({ store: h.store, run: local, writeInputs: async () => {} });
  const path = `${root}/sessions/aa/session-aa/runs/aa`, directory = await fs.directory({ path });
  const localFile = await fs.file({ path: `${path}/local-aa.json` });
  const raw = JSON.parse(localFile.text);
  raw.id = 'remote-aa'; raw.request.runtime = { profile: 'naidan-rpc', registrationId: 'old-registration', peerId: 'B'.repeat(43), label: 'Unavailable' };
  const remote = await directory.getFileHandle('remote-aa.json', { create: true }); remote.text = JSON.stringify(raw);
  const index = await directory.getFileHandle('index.json'), cached = JSON.parse(index.text);
  cached.items.push({ ...cached.items[0], id: 'remote-aa' }); index.text = JSON.stringify(cached);
  const activity = await fs.file({ path: `${root}/session-activity.json` });
  const session = await fs.file({ path: `${root}/sessions/aa/session-aa/session.json` });
  const preserved = [localFile, remote, index, activity, session].map(file => file.text);
  const writes = fs.writes.length;

  // Reopen from persisted bytes before any read can validate the opaque record.
  const reopened = await service.openImageGenerationStore({ storageType: 'opfs', creation: 'forbid' });
  if (!reopened) throw new Error('Missing reopened catalog.');
  const store = { storageType: 'opfs' as const, storeId: reopened.id };
  fs.reads.length = 0;
  const listed = await service.listImageGenerationRuns({ store, sessionId: h.session.id });
  const snapshot = await service.readImageGenerationSessionIndex({ store, sessionId: h.session.id });
  for (const result of [listed, snapshot.runs]) {
    expect(result.items.map(item => item.id).sort()).toEqual(['local-aa', 'remote-aa']);
    expect(result.warningCount).toBe(0); expect(result.warnings).toEqual([]);
  }
  expect(fs.reads.some(name => name.endsWith('/local-aa.json') || name.endsWith('/remote-aa.json'))).toBe(false);

  const runId = toImageGenerationRunId({ raw: 'remote-aa' });
  await expect(service.loadImageGenerationRun({ store, sessionId: h.session.id, runId })).rejects.toThrow('unsupported RPC runtime');
  await expect(service.updateImageGenerationRunExecution({
    store,
    sessionId: h.session.id,
    runId,
    execution: { type: 'running', startedAt: 3 },
    expectedRevision: 0,
  })).rejects.toThrow('unsupported RPC runtime');
  await expect(service.recordImageGenerationSessionUse({ store, sessionId: h.session.id, runId })).rejects.toThrow('unsupported RPC runtime');
  await expect(collectImageGenerationSessionMetadata({ store, sessionId: h.session.id })).rejects.toThrow('unsupported RPC runtime');
  expect([localFile, remote, index, activity, session].map(file => file.text)).toEqual(preserved);
  expect(fs.writes).toHaveLength(writes);
});

it.each(['wrong-id', 'wrong-session', 'wrong-width-type', 'wrong-seed-type'] as const)('does not hide %s behind an unavailable RPC runtime', async corruption => {
  const h = await setup(), local = generationRunFixture({ id: 'local-aa', sessionId: h.session.id, count: 1, seed: '42' });
  await service.createImageGenerationRun({ store: h.store, run: local, writeInputs: async () => {} });
  const path = `${root}/sessions/aa/session-aa/runs/aa`, directory = await fs.directory({ path });
  const raw = JSON.parse((await fs.file({ path: `${path}/local-aa.json` })).text);
  raw.id = 'remote-aa'; raw.request.runtime = { profile: 'naidan-rpc', registrationId: 'old-registration', peerId: 'B'.repeat(43), label: 'Unavailable' };
  switch (corruption) {
  case 'wrong-id': raw.id = 'different-aa'; break;
  case 'wrong-session': raw.sessionId = 'other-session'; break;
  case 'wrong-width-type': raw.request.parameters.width = '0'; break;
  case 'wrong-seed-type': raw.seeds = [43]; break;
  }
  const remote = await directory.getFileHandle('remote-aa.json', { create: true }); remote.text = JSON.stringify(raw);
  const activity = await fs.file({ path: `${root}/session-activity.json` }), activityBefore = activity.text;
  const binaries = await fs.root.getDirectoryHandle('binary-objects', { create: true });
  const input = await binaries.getFileHandle('input-aa', { create: true }); input.text = 'preserved input bytes';
  const before = fs.writes.length, writeInputs = vi.fn(async () => {});
  await expect(service.createImageGenerationRun({ store: h.store, run: generationRunFixture({ id: 'next-aa', sessionId: h.session.id, count: 1, seed: '42' }), writeInputs })).rejects.toThrow();
  expect(writeInputs).not.toHaveBeenCalled(); expect(fs.writes).toHaveLength(before);
  expect(directory.children.has('next-aa.json')).toBe(false);
  expect(activity.text).toBe(activityBefore);
  expect(input.text).toBe('preserved input bytes');
  expect([...binaries.children.keys()]).toEqual(['input-aa']);
});

it('keeps unsupported translation endpoints non-executable and preserves revisions for actual model changes', async () => {
  const h = await setup(), catalogDto = imageGenerationCatalogToDto({ catalog: h.catalog });
  const translation = ({ marker }: { marker: string }) => imageGenerationCatalogToDomain({
    dto: ExperimentalImageGenerationCatalogSchemaDto.parse({
      ...catalogDto,
      preferences: {
        ...catalogDto.preferences,
        generationMonitorPresentation: 'compact-progress',
        translation: {
          endpoint: { type: 'experimental_type', experimental: { endpoint: { type: 'future-rpc', registrationId: 'saved-peer', future: marker } } },
          modelId: `translation-model-${marker}`,
          lmParameters: { temperature: 0, stop: [], reasoning: { effort: 'none' } },
        },
      },
    }),
  }).preferences.translation;
  const first = await service.saveImageGenerationSession({ store: h.store, session: { ...h.session, revision: 1, translation: translation({ marker: 'A' }) }, expectedRevision: 0 });
  const activity = await fs.file({ path: `${root}/session-activity.json` }), beforeRetry = activity.text;
  const record = await fs.file({ path: `${root}/sessions/aa/session-aa/session.json` }), firstBytes = record.text;
  await service.saveImageGenerationSession({ store: h.store, session: first, expectedRevision: 0 });
  expect(activity.text).toBe(beforeRetry); expect(record.text).toBe(firstBytes);
  const writes = fs.writes.length;
  await expect(service.saveImageGenerationSession({ store: h.store, session: { ...first, translation: translation({ marker: 'B' }) }, expectedRevision: 0 })).rejects.toThrow('conflict');
  expect(fs.writes).toHaveLength(writes); expect(activity.text).toBe(beforeRetry); expect(record.text).toBe(firstBytes);
  const second = await service.saveImageGenerationSession({ store: h.store, session: { ...first, revision: 2, translation: translation({ marker: 'B' }) }, expectedRevision: 1 });
  expect(second.activityOrder).toBe(first.activityOrder! + 1);
  expect(JSON.parse(record.text).translation.endpoint).toEqual({ type: 'experimental_type' });
  expect(second.translation?.modelId).toBe('translation-model-B');
  expect(second.translation?.endpoint?.type).toBe('unsupported_experimental_endpoint');
  expect(second.translation?.lmParameters).toMatchObject({ temperature: 0, stop: [], reasoning: { effort: 'none' } });
});

it.each(['invalid-json', 'wrong-shard'] as const)('preflights %s session indexes before reserving activity', async corruption => {
  const h = await setup();
  const index = await fs.file({ path: `${root}/sessions/aa/index.json` });
  if (corruption === 'invalid-json') index.text = '{broken';
  else {
    const raw = JSON.parse(index.text); raw.items[0].id = 'other-bb'; index.text = JSON.stringify(raw);
  }
  const activity = await fs.file({ path: `${root}/session-activity.json` }), activityBefore = activity.text;
  const session = await fs.file({ path: `${root}/sessions/aa/session-aa/session.json` }), sessionBefore = session.text;
  const writes = fs.writes.length;
  await expect(service.saveImageGenerationSession({ store: h.store, session: { ...h.session, title: 'new title', revision: 1 }, expectedRevision: 0 })).rejects.toThrow();
  expect(activity.text).toBe(activityBefore); expect(session.text).toBe(sessionBefore);
  expect(fs.writes).toHaveLength(writes);
});

it('preserves an unavailable RPC run with relaxed values while allowing unrelated local work', async () => {
  const h = await setup(), local = generationRunFixture({ id: 'local-aa', sessionId: h.session.id, count: 1, seed: '42' });
  await service.createImageGenerationRun({ store: h.store, run: local, writeInputs: async () => {} });
  const path = `${root}/sessions/aa/session-aa/runs/aa`, directory = await fs.directory({ path });
  const raw = JSON.parse((await fs.file({ path: `${path}/local-aa.json` })).text);
  raw.id = 'remote-aa';
  // An old transport reference is not a current registration. Do not turn it
  // into executable local work, or discard its original fields on mutation.
  raw.request.runtime = { profile: 'naidan-rpc', connectionId: 'old-connection', peerId: 'B'.repeat(43), label: 'Unavailable', future: { retained: true } };
  raw.request.parameters.width = -0.5;
  raw.seeds = ['not-the-current-plan'];
  const remote = await directory.getFileHandle('remote-aa.json', { create: true });
  remote.text = JSON.stringify(raw);
  const preserved = remote.text;
  await service.createImageGenerationRun({
    store: h.store,
    run: generationRunFixture({ id: 'next-aa', sessionId: h.session.id, count: 1, seed: '43' }),
    writeInputs: async () => {},
  });
  expect(remote.text).toBe(preserved);
  expect(directory.children.has('next-aa.json')).toBe(true);
  await expect(service.loadImageGenerationRun({ store: h.store, sessionId: h.session.id, runId: toImageGenerationRunId({ raw: 'remote-aa' }) })).rejects.toThrow('unsupported RPC runtime');
  expect(remote.text).toBe(preserved);
});
