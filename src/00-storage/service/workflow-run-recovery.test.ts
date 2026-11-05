import { afterEach, describe, expect, it, vi } from 'vitest';
import { idToRaw, toWorkflowStepId } from '@/01-models/ids';
import type { WorkflowRunEntry } from '@/01-models/workflow';
import { workflowRunToDto } from '@/00-storage/mapper/workflow';
import { createWorkflowTestFileSystem } from './workflow-files.test-support';
import { createWorkflowTestLocks } from './workflow-locks.test-support';
import { createWorkflowRunTestStore } from './workflow-run.test-support';
import type { WorkflowRunSnapshot, WorkflowRunStore } from './workflow-run';

const definition = { name: 'Checkpointed run', steps: [] };

function entry({ preview }: { preview: string }): WorkflowRunEntry {
  return { number: 1, stepId: toWorkflowStepId({ raw: 'step' }), name: 'Finished step', trace: [], phase: 'completed', preview, inputPreview: 'input' };
}

function name({ snapshot }: { snapshot: WorkflowRunSnapshot }): string {
  return `${idToRaw({ id: snapshot.record.id })}.json`;
}

function finish({ store, previous }: { store: WorkflowRunStore, previous: WorkflowRunSnapshot }) {
  return store.finish({ previous, status: 'completed', entries: previous.record.entries, error: undefined, resultsPath: undefined, resultError: undefined });
}

afterEach(() => vi.restoreAllMocks());

describe('Workflow history ownership and recovery', () => {
  it('protects an active run from another store without blocking unrelated storage locks', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks, held } = createWorkflowTestLocks();
    await using owner = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    await using other = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await owner.create({ workflowId: undefined, definition });
    expect(await other.activity({ previous: original })).toBe('active');
    await expect(other.interrupt({ previous: original })).rejects.toThrow('active');
    await expect(other.remove({ previous: original })).rejects.toThrow('interrupted');
    await expect(finish({ store: other, previous: original })).rejects.toThrow('no longer owns');
    await expect(other.checkpoint({ previous: original, entries: [] })).rejects.toThrow('no longer owns');
    await expect(locks.request('test-workflow-storage', () => 'not blocked')).resolves.toBe('not blocked');
    expect(held).toEqual(new Set([`naidan-workflow-run-owner:${idToRaw({ id: original.record.id })}`]));
    expect((await other.load({ id: original.record.id })).source).toBe(original.source);
  });

  it('does not infer abandonment from stale timestamps or a suspended clock', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using owner = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await owner.create({ workflowId: undefined, definition });
    vi.spyOn(Date, 'now').mockReturnValue(original.record.startedAt + 365 * 24 * 60 * 60 * 1000);
    expect(await owner.activity({ previous: original })).toBe('active');
    await expect(owner.interrupt({ previous: original })).rejects.toThrow('active');
    expect((await owner.load({ id: original.record.id })).source).toBe(original.source);
  });

  it('records an abandoned checkpoint explicitly without replay or modifying its definition', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks, held } = createWorkflowTestLocks();
    await using owner = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    await using other = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await owner.create({ workflowId: undefined, definition });
    const progress = await owner.checkpoint({ previous: original, entries: [entry({ preview: 'saved output' })] });
    await owner.release({ id: original.record.id });
    const calls = [...files.calls];
    expect(await other.activity({ previous: progress })).toBe('recoverable');
    expect(files.calls).toEqual(calls);
    const now = progress.record.checkpointAt! + 10000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const recovered = await other.interrupt({ previous: progress });
    expect(recovered.record).toEqual({ ...progress.record, status: 'interrupted', finishedAt: now });
    expect(recovered.record.checkpointAt).toBe(progress.record.checkpointAt);
    expect(recovered.record.resultsPath).toBeUndefined();
    expect(await other.activity({ previous: recovered })).toBe('finished');
    expect(held.size).toBe(0);
    expect((await other.list()).items[0]?.status).toBe('interrupted');
    expect(() => finish({ store: owner, previous: recovered })).toThrow('cannot be rewritten');
  });

  it('keeps legacy running records unverifiable even when no lock exists', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    await store.release({ id: original.record.id });
    const { ownership, checkpointAt, ...legacy } = workflowRunToDto({ domain: original.record });
    expect(ownership).toBe('web_lock');
    expect(checkpointAt).toBeDefined();
    files.setText({ path: name({ snapshot: original }), text: JSON.stringify(legacy) });
    const loaded = await store.load({ id: original.record.id });
    expect(loaded.record.ownership).toBeUndefined();
    expect(loaded.record.checkpointAt).toBeUndefined();
    expect(await store.activity({ previous: loaded })).toBe('unverifiable');
    await expect(store.interrupt({ previous: loaded })).rejects.toThrow('cannot be verified');
    await expect(store.remove({ previous: loaded })).rejects.toThrow('interrupted');
    expect((await store.load({ id: loaded.record.id })).source).toBe(loaded.source);
  });

  it('still reads completed legacy records without an ownership marker', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    const terminal = await finish({ store, previous: original });
    const { ownership, checkpointAt, ...legacy } = workflowRunToDto({ domain: terminal.record });
    expect(ownership).toBe('web_lock');
    expect(checkpointAt).toBeDefined();
    files.setText({ path: name({ snapshot: terminal }), text: JSON.stringify(legacy) });
    const loaded = await store.load({ id: original.record.id });
    expect(loaded.record.status).toBe('completed');
    expect(await store.activity({ previous: loaded })).toBe('finished');
    await store.remove({ previous: loaded });
    expect((await store.list()).items).toEqual([]);
  });

  it('does not interpret a failed lock request as proof of abandonment', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    await store.release({ id: original.record.id });
    vi.spyOn(locks, 'request').mockRejectedValueOnce(new Error('lock service unavailable'));
    await expect(store.activity({ previous: original })).rejects.toThrow('lock service unavailable');
    expect((await store.load({ id: original.record.id })).source).toBe(original.source);
    expect(await store.activity({ previous: original })).toBe('recoverable');
  });

  it('releases the ownership lock when the initial snapshot cannot be persisted', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks, held } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    files.failClose({ error: new Error('quota exceeded') });
    await expect(store.create({ workflowId: undefined, definition })).rejects.toThrow('quota exceeded');
    expect(held.size).toBe(0);
    expect((await store.list()).items).toEqual([]);
  });

  it('freezes checkpoint content before waiting and never moves its timestamp backwards', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    const entries = [entry({ preview: 'captured' })];
    vi.spyOn(Date, 'now').mockReturnValue(original.record.startedAt - 1000);
    const saving = store.checkpoint({ previous: original, entries });
    entries[0]!.preview = 'later mutation';
    original.record.definition.name = 'later definition';
    const saved = await saving;
    expect(saved.record.definition.name).toBe(definition.name);
    expect(saved.record.entries[0]?.preview).toBe('captured');
    expect(saved.record.checkpointAt).toBe(saved.record.startedAt);
    const terminal = await finish({ store, previous: saved });
    expect(terminal.record.finishedAt).toBe(saved.record.startedAt);
  });

  it('requires the latest checkpoint for terminal persistence and keeps ownership on conflict', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    const progress = await store.checkpoint({ previous: original, entries: [entry({ preview: 'one' })] });
    await expect(finish({ store, previous: original })).rejects.toThrow('changed');
    expect(await store.activity({ previous: progress })).toBe('active');
    const terminal = await finish({ store, previous: progress });
    expect(terminal.record.entries).toEqual(progress.record.entries);
    expect(await store.activity({ previous: terminal })).toBe('finished');
  });

  it('preserves the previous checkpoint and its owner after a checkpoint write failure', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    files.failClose({ error: new Error('disk full') });
    await expect(store.checkpoint({ previous: original, entries: [entry({ preview: 'not saved' })] })).rejects.toThrow('disk full');
    expect((await store.load({ id: original.record.id })).source).toBe(original.source);
    expect(await store.activity({ previous: original })).toBe('active');
    const saved = await store.checkpoint({ previous: original, entries: [entry({ preview: 'retry' })] });
    expect(saved.record.entries[0]?.preview).toBe('retry');
  });

  it('keeps failed terminal saves owned until retry succeeds', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks, held } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    await using other = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    files.failClose({ error: new Error('terminal write failed') });
    await expect(finish({ store, previous: original })).rejects.toThrow('terminal write failed');
    expect(await other.activity({ previous: original })).toBe('active');
    await expect(other.interrupt({ previous: original })).rejects.toThrow('active');
    await finish({ store, previous: original });
    expect(held.size).toBe(0);
  });

  it('drains an admitted checkpoint before releasing and rejects new writes during release', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    await using other = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    const gate = Promise.withResolvers<void>();
    using unblock = {
      [Symbol.dispose]() {
        gate.resolve();
      },
    };
    let closing = false;
    files.beforeClose({
      hook: async () => {
        closing = true;
        await gate.promise;
      },
    });
    const update = store.checkpoint({ previous: original, entries: [entry({ preview: 'drained' })] });
    await vi.waitFor(() => expect(closing).toBe(true));
    let released = false;
    const release = store.release({ id: original.record.id }).then(() => {
      released = true;
    });
    await expect(store.checkpoint({ previous: original, entries: [] })).rejects.toThrow('no longer owns');
    expect(await other.activity({ previous: original })).toBe('active');
    expect(released).toBe(false);
    gate.resolve();
    const saved = await update;
    await release;
    expect(await other.activity({ previous: saved })).toBe('recoverable');
    expect((await other.interrupt({ previous: saved })).record.entries[0]?.preview).toBe('drained');
    void unblock;
  });

  it('rechecks exact source bytes under the recovery lock and releases it after a conflict', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks, held } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    const updated = await store.checkpoint({ previous: original, entries: [entry({ preview: 'newer' })] });
    await store.release({ id: original.record.id });
    await expect(store.interrupt({ previous: original })).rejects.toThrow('changed');
    expect(held.size).toBe(0);
    expect((await store.load({ id: original.record.id })).source).toBe(updated.source);
    expect((await store.interrupt({ previous: updated })).record.entries[0]?.preview).toBe('newer');
  });

  it('allows only one of two competing recovery operations to write', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks, held } = createWorkflowTestLocks();
    await using first = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    await using second = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await first.create({ workflowId: undefined, definition });
    await first.release({ id: original.record.id });
    const results = await Promise.allSettled([first.interrupt({ previous: original }), second.interrupt({ previous: original })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(files.calls.filter(call => call === `write:${name({ snapshot: original })}`)).toHaveLength(2);
    expect((await second.load({ id: original.record.id })).record.status).toBe('interrupted');
    expect(held.size).toBe(0);
  });

  it('cannot revive writer authority after explicit abandonment', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    await store.release({ id: original.record.id });
    await store.release({ id: original.record.id });
    await expect(finish({ store, previous: original })).rejects.toThrow('no longer owns');
    await expect(store.checkpoint({ previous: original, entries: [] })).rejects.toThrow('no longer owns');
    expect((await store.interrupt({ previous: original })).record.status).toBe('interrupted');
  });

  it('deletes an interrupted record without touching its files or accepting a stale snapshot', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    await store.release({ id: original.record.id });
    const recovered = await store.interrupt({ previous: original });
    files.setText({ path: 'unrelated-result.bin', text: 'retain' });
    await expect(store.remove({ previous: original })).rejects.toThrow('interrupted');
    await store.remove({ previous: recovered });
    expect((await store.list()).items).toEqual([]);
    expect(files.text({ path: 'unrelated-result.bin' })).toBe('retain');
  });

  it('keeps a recoverable checkpoint intact when recovery persistence fails', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks, held } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    await store.release({ id: original.record.id });
    files.failClose({ error: new Error('recovery write failed') });
    await expect(store.interrupt({ previous: original })).rejects.toThrow('recovery write failed');
    expect((await store.load({ id: original.record.id })).source).toBe(original.source);
    expect(held.size).toBe(0);
    expect((await store.interrupt({ previous: original })).record.status).toBe('interrupted');
  });

  it('enforces preview bounds on checkpoints, not just final records', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    const entries = Array.from({ length: 200 }, (_, index) => ({ ...entry({ preview: 'x'.repeat(4096) }), number: index + 1 }));
    const allowed = await store.checkpoint({ previous: original, entries });
    await expect(store.checkpoint({ previous: allowed, entries: [...entries, entry({ preview: '' })] })).rejects.toThrow('preview limit');
    await expect(store.checkpoint({ previous: allowed, entries: [entry({ preview: 'x'.repeat(4097) })] })).rejects.toThrow('preview limit');
    expect((await store.load({ id: original.record.id })).source).toBe(allowed.source);
    expect(await store.activity({ previous: allowed })).toBe('active');
  });

  it('rejects invalid ownership checkpoint timestamps without rewriting the bytes', async () => {
    using files = createWorkflowTestFileSystem();
    const { locks } = createWorkflowTestLocks();
    await using store = createWorkflowRunTestStore({ directory: files.root, locks, wait: undefined });
    const original = await store.create({ workflowId: undefined, definition });
    await store.release({ id: original.record.id });
    for (const checkpointAt of [undefined, original.record.startedAt - 1, 0.25]) {
      const source = JSON.stringify({ ...workflowRunToDto({ domain: original.record }), checkpointAt });
      files.setText({ path: name({ snapshot: original }), text: source });
      await expect(store.load({ id: original.record.id })).rejects.toThrow(/checkpoint/);
      expect(files.text({ path: name({ snapshot: original }) })).toBe(source);
    }
  });
});
