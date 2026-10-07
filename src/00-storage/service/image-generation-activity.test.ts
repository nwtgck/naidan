import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentalImageGenerationActivityJournalSchemaDto, ExperimentalImageGenerationSessionSchemaDto } from '@/00-storage/00-dto/experimental-image-generation.dto';
import { idToRaw } from '@/01-models/ids';
import type { ImageGenerationSession } from '@/01-models/image-generation';
import { createImageGenerationStorageHarness, generationRunFixture, generationSessionFixture } from './image-generation/test-support';
import * as service from './image-generation';

const root = '/naidan-storage/experimental/image-generation';
let fs: ReturnType<typeof createImageGenerationStorageHarness>;
beforeEach(() => {
  fs = createImageGenerationStorageHarness();
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function setup() {
  const catalog = await service.openImageGenerationStore({ storageType: 'opfs', creation: 'allow' });
  if (!catalog) throw new Error('Missing catalog');
  const store = { storageType: 'opfs' as const, storeId: catalog.id };
  const a = await service.saveImageGenerationSession({ store, session: generationSessionFixture({ id: 'session-aa' }), expectedRevision: undefined });
  const b = await service.saveImageGenerationSession({ store, session: generationSessionFixture({ id: 'session-bb' }), expectedRevision: undefined });
  return { store, a, b };
}
async function accept({ store, session, id, time }: { store: service.ImageGenerationStoreAccess, session: ImageGenerationSession, id: string, time: number }) {
  const run = { ...generationRunFixture({ id, sessionId: session.id, count: 1, seed: '42' }), createdAt: time };
  const writeInputs = vi.fn(async () => {});
  await service.createImageGenerationRun({ store, run, writeInputs });
  return { run, writeInputs };
}
async function journal() {
  return ExperimentalImageGenerationActivityJournalSchemaDto.parse(JSON.parse((await fs.file({ path: `${root}/session-activity.json` })).text));
}
async function order({ store }: { store: service.ImageGenerationStoreAccess }) {
  return (await service.listImageGenerationSessions({ store })).items.map(item => idToRaw({ id: item.id }));
}

describe('durable, wall-clock-independent image session activity', () => {
  it.each([[100, 100], [100, 1]])('orders acceptance at %i then %i without rewriting real timestamps', async (first, second) => {
    const { store, a, b } = await setup();
    await accept({ store, session: a, id: 'run-aa', time: first });
    await accept({ store, session: b, id: 'run-bb', time: second });
    expect(await order({ store })).toEqual(['session-bb', 'session-aa']);
    const sessions = (await service.listImageGenerationSessions({ store })).items;
    expect(sessions[0]?.updatedAt).toBe(second);
    expect(sessions[1]?.updatedAt).toBe(first);
    expect(sessions[0]!.activityOrder).toBeGreaterThan(sessions[1]!.activityOrder!);
    expect((await journal()).pending).toEqual([]);
  });
  it('replays accepted runs using only persisted bytes, not page retry objects', async () => {
    const { store, a } = await setup();
    const { run, writeInputs } = await accept({ store, session: a, id: 'run-aa', time: 0 });
    const before = await journal();
    expect(before.pending).toHaveLength(1);
    expect(await order({ store })).toEqual(['session-aa', 'session-bb']);
    expect((await journal()).sequence).toBe(before.sequence);
    expect((await journal()).pending).toEqual([]);
    expect(writeInputs).toHaveBeenCalledTimes(1);
    expect((await service.loadImageGenerationRun({ store, sessionId: a.id, runId: run.id }))?.execution.type).toBe('queued');
  });
  it('keeps an old retry behind later use, even with a much newer timestamp', async () => {
    const { store, a, b } = await setup();
    const first = await accept({ store, session: a, id: 'run-aa', time: 1_000_000 });
    await accept({ store, session: b, id: 'run-bb', time: 1 });
    const sequence = (await journal()).sequence;
    expect(await order({ store })).toEqual(['session-bb', 'session-aa']);
    await service.recordImageGenerationSessionUse({ store, sessionId: a.id, runId: first.run.id });
    expect(await order({ store })).toEqual(['session-bb', 'session-aa']);
    expect((await journal()).sequence).toBe(sequence);
  });
  it('reports one failed activity write without blocking another accepted session', async () => {
    const { store, a, b } = await setup();
    await accept({ store, session: a, id: 'run-aa', time: 20 });
    await accept({ store, session: b, id: 'run-bb', time: 1 });
    fs.faults.add(`write:${root}/sessions/aa/session-aa/session.json`);
    const failed = await service.listImageGenerationSessions({ store });
    expect(failed.warningCount).toBe(1);
    expect(failed.items[0]?.id).toBe(b.id);
    expect((await journal()).pending.map(entry => entry.sessionId)).toEqual(['session-aa']);
    expect(await order({ store })).toEqual(['session-bb', 'session-aa']);
    expect((await journal()).pending).toEqual([]);
  });
  it('recovers a published run after the run-index acknowledgement fails', async () => {
    const { store, a } = await setup();
    const run = generationRunFixture({ id: 'run-aa', sessionId: a.id, count: 1, seed: '42' });
    fs.faults.add(`write:${root}/sessions/aa/session-aa/runs/aa/index.json`);
    await expect(service.createImageGenerationRun({ store, run, writeInputs: async () => {} })).rejects.toThrow('Injected');
    const saved = await service.loadImageGenerationRun({ store, sessionId: a.id, runId: run.id });
    expect(saved?.acceptedOrder).toBeGreaterThan(0);
    const sequence = (await journal()).sequence;
    expect(await order({ store })).toEqual(['session-aa', 'session-bb']);
    await service.createImageGenerationRun({ store, run, writeInputs: async () => {} });
    expect((await journal()).sequence).toBe(sequence);
    expect((await service.loadImageGenerationRun({ store, sessionId: a.id, runId: run.id }))?.acceptedOrder).toBe(saved?.acceptedOrder);
  });
  it('does not reserve or reorder when input publication fails', async () => {
    const { store, a } = await setup();
    const before = await journal();
    const run = generationRunFixture({ id: 'run-aa', sessionId: a.id, count: 1, seed: '42' });
    await expect(service.createImageGenerationRun({
      store,
      run,
      writeInputs: async () => {
      throw new Error('input failure');
    },
    })).rejects.toThrow('input failure');
    expect(await journal()).toEqual(before);
    expect(await order({ store })).toEqual(['session-bb', 'session-aa']);
  });
  it('cleans an unaccepted reservation after canonical run publication fails', async () => {
    const { store, a } = await setup();
    const run = generationRunFixture({ id: 'run-aa', sessionId: a.id, count: 1, seed: '42' });
    fs.faults.add(`write:${root}/sessions/aa/session-aa/runs/aa/run-aa.json`);
    await expect(service.createImageGenerationRun({ store, run, writeInputs: async () => {} })).rejects.toThrow('Injected');
    expect((await journal()).pending).toEqual([]);
    expect(await order({ store })).toEqual(['session-bb', 'session-aa']);
  });
  it('repairs dirty session indexes without advancing order on an identical save retry', async () => {
    const { store, a } = await setup();
    const next = { ...a, revision: a.revision + 1, title: 'new title', updatedAt: 0 };
    fs.faults.add(`write:${root}/sessions/aa/index.json`);
    await expect(service.saveImageGenerationSession({ store, session: next, expectedRevision: a.revision })).rejects.toThrow('Injected');
    const sequence = (await journal()).sequence;
    const saved = await service.saveImageGenerationSession({ store, session: next, expectedRevision: a.revision });
    expect(saved.activityOrder).toBe(sequence);
    expect(saved.updatedAt).toBe(0);
    expect((await journal()).sequence).toBe(sequence);
    expect(await order({ store })).toEqual(['session-aa', 'session-bb']);
  });
  it('does not revive a deleted session from durable pending activity', async () => {
    const { store, a } = await setup();
    await accept({ store, session: a, id: 'run-aa', time: 2 });
    await service.deleteImageGenerationSession({ store, sessionId: a.id, expectedRevision: a.revision });
    expect(await order({ store })).toEqual(['session-bb']);
    expect((await journal()).pending).toEqual([]);
    expect(await service.loadImageGenerationSession({ store, sessionId: a.id })).toBeUndefined();
  });
  it('preserves later metadata edits and their position while replaying an older run', async () => {
    const { store, a, b } = await setup();
    await accept({ store, session: a, id: 'run-aa', time: 100 });
    const renamed = await service.saveImageGenerationSession({ store, session: { ...a, title: 'renamed', revision: a.revision + 1 }, expectedRevision: a.revision });
    await accept({ store, session: b, id: 'run-bb', time: 1 });
    expect(await order({ store })).toEqual(['session-bb', 'session-aa']);
    const latest = await service.loadImageGenerationSession({ store, sessionId: a.id });
    expect(latest).toMatchObject({ title: 'renamed', activityOrder: renamed.activityOrder });
  });
  it('keeps legacy timestamp order without creating a journal on read-only listing', async () => {
    const { store, a, b } = await setup();
    for (const session of [a, b]) {
      const raw = idToRaw({ id: session.id }), shard = raw.slice(-2);
      const file = await fs.file({ path: `${root}/sessions/${shard}/${raw}/session.json` });
      const { activityOrder: _activityOrder, ...data } = ExperimentalImageGenerationSessionSchemaDto.parse(JSON.parse(file.text));
      file.text = JSON.stringify({ ...data, updatedAt: session.id === a.id ? 20 : 10 });
      await (await fs.directory({ path: `${root}/sessions/${shard}` })).removeEntry('index.json');
    }
    await (await fs.directory({ path: root })).removeEntry('session-activity.json');
    const writes = fs.writes.length;
    expect(await order({ store })).toEqual(['session-aa', 'session-bb']);
    expect(fs.writes).toHaveLength(writes);
    const fresh = await service.saveImageGenerationSession({ store, session: generationSessionFixture({ id: 'session-cc' }), expectedRevision: undefined });
    expect(fresh.activityOrder).toBe(1);
    expect(await order({ store })).toEqual(['session-cc', 'session-aa', 'session-bb']);
  });
  it.each(['{broken', '{"version":2,"future":true}'])('does not replace an unreadable activity clock: %s', async text => {
    const { store, a } = await setup();
    const file = await fs.file({ path: `${root}/session-activity.json` }); file.text = text;
    const listing = await service.listImageGenerationSessions({ store });
    expect(listing.warningCount).toBe(1);
    expect(listing.items).toHaveLength(2);
    await expect(service.saveImageGenerationSession({ store, session: { ...a, revision: a.revision + 1, title: 'edit' }, expectedRevision: a.revision })).rejects.toThrow();
    expect(file.text).toBe(text);
  });
  it('fails closed rather than restarting a deleted clock in an ordered store', async () => {
    const { store, a } = await setup();
    await (await fs.directory({ path: root })).removeEntry('session-activity.json');
    await expect(service.saveImageGenerationSession({ store, session: { ...a, revision: 1, title: 'edit' }, expectedRevision: 0 })).rejects.toThrow('clock is missing');
  });
  it('refuses clock exhaustion without rounding orders or publishing a run', async () => {
    const { store, a } = await setup();
    const file = await fs.file({ path: `${root}/session-activity.json` });
    file.text = JSON.stringify({ version: 1, sequence: Number.MAX_SAFE_INTEGER - 1, pending: [] });
    const before = file.text;
    const run = generationRunFixture({ id: 'run-aa', sessionId: a.id, count: 1, seed: '42' });
    await expect(service.createImageGenerationRun({ store, run, writeInputs: async () => {} })).rejects.toThrow();
    expect(file.text).toBe(before);
    expect(await service.loadImageGenerationRun({ store, sessionId: a.id, runId: run.id })).toBeUndefined();
  });
  it('does not repeat a metadata update when only clearing the durable receipt failed', async () => {
    const { store, a } = await setup();
    await accept({ store, session: a, id: 'run-aa', time: 20 });
    fs.faults.add(`write:${root}/session-activity.json`);
    const first = await service.listImageGenerationSessions({ store });
    expect(first.warningCount).toBe(1);
    const accepted = first.items.find(session => session.id === a.id)!;
    expect((await journal()).pending).toHaveLength(1);
    const second = await service.listImageGenerationSessions({ store });
    expect(second.warningCount).toBe(0);
    expect(second.items.find(session => session.id === a.id)).toEqual(accepted);
    expect((await journal()).pending).toEqual([]);
  });
  it('does not publish a run when reserving durable order fails', async () => {
    const { store, a } = await setup();
    const before = await journal();
    fs.faults.add(`write:${root}/session-activity.json`);
    const run = generationRunFixture({ id: 'run-aa', sessionId: a.id, count: 1, seed: '42' });
    await expect(service.createImageGenerationRun({ store, run, writeInputs: async () => {} })).rejects.toThrow('Injected');
    expect(await service.loadImageGenerationRun({ store, sessionId: a.id, runId: run.id })).toBeUndefined();
    expect(await journal()).toEqual(before);
    expect(await order({ store })).toEqual(['session-bb', 'session-aa']);
  });
  it('cleans an interrupted, unpublished receipt without moving any session', async () => {
    const { store, a } = await setup();
    const before = await journal();
    const file = await fs.file({ path: `${root}/session-activity.json` });
    file.text = JSON.stringify({
      ...before,
      sequence: before.sequence + 1,
      pending: [{ sessionId: idToRaw({ id: a.id }), runId: 'run-orphan', order: before.sequence + 1 }],
    });
    expect(await order({ store })).toEqual(['session-bb', 'session-aa']);
    expect((await journal()).pending).toEqual([]);
    expect((await journal()).sequence).toBe(before.sequence + 1);
  });
  it('rejects duplicate or mismatching order metadata without destroying unknown receipts', async () => {
    const { store, a } = await setup();
    await accept({ store, session: a, id: 'run-aa', time: 20 });
    const value = await journal();
    const file = await fs.file({ path: `${root}/session-activity.json` });
    file.text = JSON.stringify({ ...value, pending: [...value.pending, ...value.pending] });
    const raw = file.text;
    const failed = await service.listImageGenerationSessions({ store });
    expect(failed.warningCount).toBe(1);
    expect(file.text).toBe(raw);
    file.text = JSON.stringify({
      ...value,
      sequence: value.sequence + 1,
      pending: value.pending.map(entry => ({ ...entry, order: value.sequence + 1 })),
    });
    const mismatching = file.text;
    expect((await service.listImageGenerationSessions({ store })).warningCount).toBe(1);
    expect(file.text).toBe(mismatching);
  });

});
