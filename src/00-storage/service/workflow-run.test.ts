import { describe, it, expect } from 'vitest';
import { createWorkflowRunTestStore } from './workflow-run.test-support';
import { createWorkflowTestLocks } from './workflow-locks.test-support';
import { createWorkflowTestFileSystem } from './workflow-files.test-support';
import { idToRaw, toWorkflowId, toWorkflowRunId, toWorkflowStepId } from '@/01-models/ids';
import { OPFS_TMP_DIR } from '@/constants';
import type { WorkflowRunSnapshot, WorkflowRunStore } from './workflow-run';

function store({ directory, wait }: { directory: FileSystemDirectoryHandle, wait: Promise<void> | undefined }) {
  return createWorkflowRunTestStore({ directory, wait, locks: createWorkflowTestLocks().locks });
}

function finish({ runs, previous }: { runs: WorkflowRunStore, previous: WorkflowRunSnapshot }) {
  return runs.finish({ previous, status: 'completed', entries: [], error: undefined, resultsPath: undefined, resultError: undefined });
}

describe('Workflow run persistence', () => {
  it('snapshots the exact unsaved definition without depending on a source document', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const definition = { name: 'Before', steps: [] };
    const pending = runs.create({ workflowId: undefined, definition });
    definition.name = 'After';
    const saved = await pending;
    expect(idToRaw({ id: saved.record.id })).toHaveLength(21);
    expect(saved.record.workflowId).toBeUndefined();
    expect(saved.record.definition.name).toBe('Before');
    expect((await runs.load({ id: saved.record.id })).record.definition.name).toBe('Before');
  });

  it('creates a new identity for every run and retains incomplete records', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const args = { workflowId: toWorkflowId({ raw: 'deleted-workflow' }), definition: { name: 'Standalone history', steps: [] } };
    const first = await runs.create(args), second = await runs.create(args);
    expect(first.record.id).not.toBe(second.record.id);
    const listing = await runs.list();
    expect(listing.items).toHaveLength(2);
    expect(listing.items.every(item => item.status === 'running')).toBe(true);
    expect((await runs.load({ id: first.record.id })).record.definition.name).toBe('Standalone history');
  });

  it('keeps the snapshot independent of later mutation while recording bounded progress', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const original = await runs.create({ workflowId: undefined, definition: { name: 'Original', steps: [] } });
    original.record.definition.name = 'Mutated by caller';
    const final = await runs.finish({
      previous: original,
      status: 'failed',
      entries: [{ number: 1, stepId: toWorkflowStepId({ raw: 'step' }), name: 'Generate', trace: [0], phase: 'running', preview: 'partial', inputPreview: 'question' }],
      error: 'Provider failed',
      resultsPath: [OPFS_TMP_DIR, 'owner', 'workflow-results-test'],
      resultError: undefined,
    });
    expect(final.record.definition.name).toBe('Original');
    expect(final.record.finishedAt).toBeGreaterThanOrEqual(final.record.startedAt);
    expect(final.record.entries[0]?.preview).toBe('partial');
    expect(final.record.status).toBe('failed');
  });

  it('does not clobber a terminal record with a stale second completion or deletion', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const original = await runs.create({ workflowId: undefined, definition: { name: 'One', steps: [] } });
    const final = await finish({ runs, previous: original });
    await expect(finish({ runs, previous: original })).rejects.toThrow('no longer owns');
    await expect(runs.remove({ previous: original })).rejects.toThrow('interrupted');
    expect(() => finish({ runs, previous: final })).toThrow('cannot be rewritten');
  });

  it('does not recreate a history record removed before completion', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const original = await runs.create({ workflowId: undefined, definition: { name: 'Deleted', steps: [] } });
    // Simulate an older writer that did not participate in run ownership.
    await files.root.removeEntry(`${idToRaw({ id: original.record.id })}.json`);
    await expect(finish({ runs, previous: original })).rejects.toThrow('removed');
    expect((await runs.list()).items).toEqual([]);
  });

  it('preserves the last durable record when closing fails', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const original = await runs.create({ workflowId: undefined, definition: { name: 'Start', steps: [] } });
    files.failClose({ error: new Error('disk full') });
    await expect(finish({ runs, previous: original })).rejects.toThrow('disk full');
    expect((await runs.load({ id: original.record.id })).source).toBe(original.source);
  });

  it('rejects path traversal and paths outside runtime result folders', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const original = await runs.create({ workflowId: undefined, definition: { name: 'Safe', steps: [] } });
    for (const path of [['naidan-storage', 'settings'], [OPFS_TMP_DIR, '..', 'workflow-results-a'], [OPFS_TMP_DIR, 'owner', 'other']]) {
      await expect(runs.finish({ previous: original, status: 'completed', entries: [], error: undefined, resultsPath: path, resultError: undefined })).rejects.toThrow('temporary');
    }
    await expect(runs.load({ id: toWorkflowRunId({ raw: '../settings' }) })).rejects.toThrow('Invalid');
  });

  it('lists corrupt or mismatched identities without deleting the original bytes', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const original = await runs.create({ workflowId: undefined, definition: { name: 'Good', steps: [] } });
    files.setText({ path: 'broken.json', text: '{invalid' });
    files.setText({ path: 'different.json', text: original.source });
    const listing = await runs.list();
    expect(listing.items).toHaveLength(1);
    expect(listing.unreadable).toHaveLength(2);
    expect(files.text({ path: 'broken.json' })).toBe('{invalid');
  });

  it('rejects oversized previews instead of storing unbounded generation output', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const original = await runs.create({ workflowId: undefined, definition: { name: 'Bounded', steps: [] } });
    await expect(runs.finish({
      previous: original,
      status: 'completed',
      entries: [{ number: 1, stepId: toWorkflowStepId({ raw: 'step' }), name: 'Step', trace: [], phase: 'completed', preview: 'x'.repeat(4097), inputPreview: '' }],
      error: undefined,
      resultsPath: undefined,
      resultError: undefined,
    })).rejects.toThrow('preview limit');
  });

  it('never deletes result files when removing a record', async () => {
    using files = createWorkflowTestFileSystem();
    await using runs = store({ directory: files.root, wait: undefined });
    const original = await runs.create({ workflowId: undefined, definition: { name: 'Kept files', steps: [] } });
    const final = await finish({ runs, previous: original });
    files.setText({ path: 'retained-result.txt', text: 'keep' });
    await runs.remove({ previous: final });
    expect(files.text({ path: 'retained-result.txt' })).toBe('keep');
  });
});
