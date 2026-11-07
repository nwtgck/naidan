import { describe, it, expect } from 'vitest';
import { TEST_ONLY, createWorkflowDocumentStore } from './workflow-document';
import { createWorkflowTestFileSystem } from './workflow-files.test-support';
import { idToRaw } from '@/01-models/ids';

function store({ directory, wait }: { directory: FileSystemDirectoryHandle, wait: Promise<void> | undefined }) {
  let tail = Promise.resolve();
  return TEST_ONLY.createStore({
    access: {
      directory: async () => directory,
      lock({ operation }) {
        const next = tail.then(async () => {
          await wait;
          return operation();
        });
        tail = next.then(() => undefined, () => undefined);
        return next;
      },
    },
  });
}

describe('Workflow document persistence', () => {
  it('creates separate workflow and part records with managed identity and dates', async () => {
    using files = createWorkflowTestFileSystem();
    const documents = store({ directory: files.root, wait: undefined });
    const first = await documents.save({ previous: undefined, kind: 'workflow', definition: { name: 'First', steps: [] } });
    const part = await documents.save({ previous: undefined, kind: 'part', definition: { name: 'Part', steps: [] } });
    expect(first.document.id).not.toBe(part.document.id);
    expect(idToRaw({ id: first.document.id })).toHaveLength(21);
    expect(first.document.createdAt).toBeGreaterThan(0);
    const listing = await documents.list();
    expect(listing.items).toHaveLength(2);
    expect(listing.unreadable).toEqual([]);
    expect((await documents.load({ id: first.document.id })).document.definition).toEqual({ name: 'First', steps: [] });
  });

  it('preserves identity on edit and rejects a stale writer or stale deletion', async () => {
    using files = createWorkflowTestFileSystem();
    const documents = store({ directory: files.root, wait: undefined });
    const original = await documents.save({ previous: undefined, kind: 'workflow', definition: { name: 'A', steps: [] } });
    const next = await documents.save({ previous: original, kind: 'workflow', definition: { name: 'B', steps: [] } });
    expect(next.document.id).toBe(original.document.id);
    expect(next.document.createdAt).toBe(original.document.createdAt);
    await expect(documents.save({ previous: original, kind: 'workflow', definition: { name: 'C', steps: [] } })).rejects.toThrow('another editor');
    await expect(documents.remove({ previous: original })).rejects.toThrow('changed');
    expect((await documents.load({ id: next.document.id })).document.definition.name).toBe('B');
    await documents.remove({ previous: next });
    expect((await documents.list()).items).toEqual([]);
  });

  it('snapshots edits before an asynchronous lock is acquired', async () => {
    using files = createWorkflowTestFileSystem();
    const gate = Promise.withResolvers<void>();
    const documents = store({ directory: files.root, wait: gate.promise });
    const definition = { name: 'before', steps: [] };
    const pending = documents.save({ previous: undefined, kind: 'workflow', definition });
    definition.name = 'after';
    gate.resolve();
    expect((await pending).document.definition.name).toBe('before');
  });

  it('does not overwrite old content when closing a replacement fails', async () => {
    using files = createWorkflowTestFileSystem();
    const documents = store({ directory: files.root, wait: undefined });
    const original = await documents.save({ previous: undefined, kind: 'workflow', definition: { name: 'A', steps: [] } });
    files.failClose({ error: new Error('Disk unavailable') });
    await expect(documents.save({ previous: original, kind: 'workflow', definition: { name: 'B', steps: [] } })).rejects.toThrow('Disk');
    expect((await documents.load({ id: original.document.id })).source).toBe(original.source);
  });

  it('lists unreadable records without deleting or silently replacing them', async () => {
    using files = createWorkflowTestFileSystem();
    const documents = store({ directory: files.root, wait: undefined });
    files.setText({ path: 'broken.json', text: '{not valid' });
    expect((await documents.list()).unreadable).toHaveLength(1);
    expect(files.text({ path: 'broken.json' })).toBe('{not valid');
  });

  it('refuses a file whose embedded identity differs from its name', async () => {
    using files = createWorkflowTestFileSystem();
    const documents = store({ directory: files.root, wait: undefined });
    const original = await documents.save({ previous: undefined, kind: 'workflow', definition: { name: 'A', steps: [] } });
    files.setText({ path: `${idToRaw({ id: original.document.id })}.json`, text: original.source.replace(idToRaw({ id: original.document.id }), 'other') });
    await expect(documents.load({ id: original.document.id })).rejects.toThrow('identity');
  });

  it('does not silently change a stored document into a part', async () => {
    using files = createWorkflowTestFileSystem();
    const documents = store({ directory: files.root, wait: undefined });
    const original = await documents.save({ previous: undefined, kind: 'workflow', definition: { name: 'A', steps: [] } });
    await expect(documents.save({ previous: original, kind: 'part', definition: original.document.definition })).rejects.toThrow('identity');
  });

  it('keeps unsupported storage providers explicit', () => {
    expect(() => createWorkflowDocumentStore({ storageType: 'memory' })).toThrow('OPFS');
    expect(() => createWorkflowDocumentStore({ storageType: 'local' })).toThrow('OPFS');
  });
});
