import { describe, expect, it } from 'vitest';
import {
  PersistentHizoFSIndex,
  type PersistentIndexPage,
  type PersistentIndexPageStore,
} from './persistent-index';

type Entry = {
  readonly key: string;
  readonly value: number;
};

class MemoryPageStore implements PersistentIndexPageStore<string, Entry> {
  readonly pages = new Map<string, PersistentIndexPage<string, Entry>>();
  reads = 0;
  writes = 0;

  async readPage({ objectId }: {
    objectId: string;
  }): Promise<PersistentIndexPage<string, Entry>> {
    this.reads += 1;
    const page = this.pages.get(objectId);
    if (page === undefined) {
      throw new Error(`Missing page: ${objectId}`);
    }
    return structuredClone(page);
  }

  async writePage({ page }: {
    page: PersistentIndexPage<string, Entry>;
  }): Promise<string> {
    this.writes += 1;
    const objectId = `page-${String(this.writes)}`;
    this.pages.set(objectId, structuredClone(page));
    return objectId;
  }
}

function createIndex({ pageStore }: {
  pageStore: MemoryPageStore;
}): PersistentHizoFSIndex<string, Entry> {
  return new PersistentHizoFSIndex({
    pageStore,
    compare: ({ left, right }) => left.localeCompare(right),
    getEntryKey: ({ entry }) => entry.key,
    maxPageEntries: 3,
  });
}

async function collect({
  index,
  rootObjectId,
}: {
  index: PersistentHizoFSIndex<string, Entry>;
  rootObjectId: string;
}): Promise<readonly Entry[]> {
  const entries: Entry[] = [];
  for await (const entry of index.entries({ rootObjectId })) {
    entries.push(entry);
  }
  return entries;
}

describe('persistent HizoFS index', () => {
  it('splits immutable pages while preserving the old root snapshot', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    const emptyRoot = await index.createEmpty();
    let root = emptyRoot;

    for (let value = 19; value >= 0; value -= 1) {
      root = await index.set({
        rootObjectId: root,
        entry: {
          key: String(value).padStart(2, '0'),
          value,
        },
      });
    }

    expect(await collect({ index, rootObjectId: emptyRoot })).toEqual([]);
    expect((await collect({ index, rootObjectId: root })).map(entry => entry.value)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
    for (let value = 0; value < 20; value += 1) {
      await expect(index.get({
        rootObjectId: root,
        key: String(value).padStart(2, '0'),
      })).resolves.toEqual({
        key: String(value).padStart(2, '0'),
        value,
      });
    }
  });

  it('reuses the rightmost path for verified monotonic appends', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    let root = await index.createEmpty();

    for (let value = 0; value < 50; value += 1) {
      root = await index.setWithRightmostPathCache({
        rootObjectId: root,
        entry: { key: String(value).padStart(2, '0'), value },
      });
    }

    expect(pageStore.reads).toBe(2);
    expect((await collect({ index, rootObjectId: root })).map(entry => entry.value))
      .toEqual(Array.from({ length: 50 }, (_, value) => value));
    await expect(index.validateStructure({ rootObjectId: root })).resolves.toMatchObject({
      entryCount: 50,
    });

    root = await index.set({
      rootObjectId: root,
      entry: { key: '25', value: 2500 },
    });
    root = await index.setWithRightmostPathCache({
      rootObjectId: root,
      entry: { key: '50', value: 50 },
    });
    await expect(index.get({ rootObjectId: root, key: '25' })).resolves.toEqual({
      key: '25',
      value: 2500,
    });
    await expect(index.get({ rootObjectId: root, key: '50' })).resolves.toEqual({
      key: '50',
      value: 50,
    });
  });

  it('reuses one immutable leaf for lookups within its key range', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    const root = await index.buildFromSortedEntries({
      entries: Array.from({ length: 12 }, (_, value) => ({
        key: String(value).padStart(2, '0'),
        value,
      })),
    });
    const cache = { value: undefined };

    await expect(index.getWithLeafCache({
      rootObjectId: root,
      key: '00',
      cache,
    })).resolves.toEqual({ key: '00', value: 0 });
    const readsAfterFirstLookup = pageStore.reads;
    await expect(index.getWithLeafCache({
      rootObjectId: root,
      key: '01',
      cache,
    })).resolves.toEqual({ key: '01', value: 1 });
    await expect(index.getWithLeafCache({
      rootObjectId: root,
      key: '02',
      cache,
    })).resolves.toEqual({ key: '02', value: 2 });
    expect(pageStore.reads).toBe(readsAfterFirstLookup);

    const nextRoot = await index.set({
      rootObjectId: root,
      entry: { key: '01', value: 100 },
    });
    await expect(index.getWithLeafCache({
      rootObjectId: nextRoot,
      key: '01',
      cache,
    })).resolves.toEqual({ key: '01', value: 100 });
    expect(pageStore.reads).toBeGreaterThan(readsAfterFirstLookup);
  });

  it('rewrites only one root-to-leaf path for an existing key', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    let root = await index.createEmpty();
    for (let value = 0; value < 30; value += 1) {
      root = await index.set({
        rootObjectId: root,
        entry: { key: String(value).padStart(2, '0'), value },
      });
    }

    const writesBefore = pageStore.writes;
    const previousRoot = root;
    root = await index.set({
      rootObjectId: root,
      entry: { key: '15', value: 1500 },
    });

    expect(pageStore.writes - writesBefore).toBeLessThanOrEqual(5);
    expect(await index.get({ rootObjectId: previousRoot, key: '15' })).toEqual({
      key: '15',
      value: 15,
    });
    expect(await index.get({ rootObjectId: root, key: '15' })).toEqual({
      key: '15',
      value: 1500,
    });
  });

  it('batch-sets entries by rewriting each affected path once', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    let root = await index.createEmpty();
    for (let value = 0; value < 100; value += 1) {
      root = await index.set({
        rootObjectId: root,
        entry: { key: String(value).padStart(3, '0'), value },
      });
    }

    const previousRoot = root;
    const writesBefore = pageStore.writes;
    root = await index.setMany({
      rootObjectId: root,
      entries: [
        { key: '011', value: 1100 },
        { key: '010', value: 1000 },
      ],
    });
    const batchWrites = pageStore.writes - writesBefore;

    let sequentialRoot = previousRoot;
    const sequentialWritesBefore = pageStore.writes;
    sequentialRoot = await index.set({
      rootObjectId: sequentialRoot,
      entry: { key: '010', value: 1000 },
    });
    sequentialRoot = await index.set({
      rootObjectId: sequentialRoot,
      entry: { key: '011', value: 1100 },
    });
    const sequentialWrites = pageStore.writes - sequentialWritesBefore;

    expect(batchWrites).toBeLessThan(sequentialWrites);
    expect(await index.get({ rootObjectId: previousRoot, key: '010' })).toEqual({
      key: '010',
      value: 10,
    });
    expect(await index.get({ rootObjectId: root, key: '010' })).toEqual({
      key: '010',
      value: 1000,
    });
    expect(await index.get({ rootObjectId: root, key: '011' })).toEqual({
      key: '011',
      value: 1100,
    });
    await expect(index.validateStructure({ rootObjectId: sequentialRoot }))
      .resolves.toMatchObject({ entryCount: 100 });
  });

  it('batch-sets entries across leaves and rejects duplicate keys', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    let root = await index.createEmpty();
    root = await index.setMany({
      rootObjectId: root,
      entries: Array.from({ length: 20 }, (_, value) => ({
        key: String(value).padStart(2, '0'),
        value,
      })).reverse(),
    });

    expect((await collect({ index, rootObjectId: root })).map(entry => entry.value)).toEqual(
      Array.from({ length: 20 }, (_, value) => value),
    );
    await expect(index.validateStructure({ rootObjectId: root })).resolves.toMatchObject({
      entryCount: 20,
    });
    await expect(index.setMany({
      rootObjectId: root,
      entries: [
        { key: '10', value: 1 },
        { key: '10', value: 2 },
      ],
    })).rejects.toThrow('batch entries must be unique');
  });

  it('deletes keys without rebuilding unrelated leaves and collapses an empty root', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    let root = await index.createEmpty();
    for (let value = 0; value < 12; value += 1) {
      root = await index.set({
        rootObjectId: root,
        entry: { key: String(value).padStart(2, '0'), value },
      });
    }

    for (let value = 0; value < 12; value += 2) {
      root = await index.delete({
        rootObjectId: root,
        key: String(value).padStart(2, '0'),
      });
    }
    expect((await collect({ index, rootObjectId: root })).map(entry => entry.value)).toEqual([
      1, 3, 5, 7, 9, 11,
    ]);

    for (let value = 1; value < 12; value += 2) {
      root = await index.delete({
        rootObjectId: root,
        key: String(value).padStart(2, '0'),
      });
    }
    expect(await collect({ index, rootObjectId: root })).toEqual([]);
  });

  it('does not create a new page when deleting a missing key', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    const root = await index.createEmpty();
    const writesBefore = pageStore.writes;
    expect(await index.delete({ rootObjectId: root, key: 'missing' })).toBe(root);
    expect(pageStore.writes).toBe(writesBefore);
  });

  it('validates parent bounds against the actual child subtree', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    let root = await index.createEmpty();
    for (let value = 0; value < 20; value += 1) {
      root = await index.set({
        rootObjectId: root,
        entry: { key: String(value).padStart(2, '0'), value },
      });
    }
    await expect(index.validateStructure({ rootObjectId: root })).resolves.toMatchObject({
      entryCount: 20,
    });
    const rootPage = pageStore.pages.get(root);
    if (rootPage === undefined || rootPage.type !== 'branch') {
      throw new Error('Expected a branch root');
    }
    const lastChild = rootPage.children.at(-1);
    if (lastChild === undefined) throw new Error('Expected a branch child');
    pageStore.pages.set(root, {
      ...rootPage,
      children: [
        ...rootPage.children.slice(0, -1),
        { ...lastChild, upperBound: 'zz' },
      ],
    });
    await expect(index.validateStructure({ rootObjectId: root })).rejects.toThrow(
      'upper bound',
    );
  });

  it('batch-deletes sorted keys without one copy-on-write path per key', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    let root = await index.createEmpty();
    for (let value = 0; value < 100; value += 1) {
      root = await index.set({
        rootObjectId: root,
        entry: { key: String(value).padStart(3, '0'), value },
      });
    }
    const writesBefore = pageStore.writes;
    root = await index.deleteMany({
      rootObjectId: root,
      keys: new Set(Array.from({ length: 80 }, (_, value) => String(value).padStart(3, '0'))),
    });
    expect(pageStore.writes - writesBefore).toBeLessThan(30);
    expect((await collect({ index, rootObjectId: root })).map(entry => entry.value)).toEqual(
      Array.from({ length: 20 }, (_, index_) => index_ + 80),
    );
  });

  it('rewrites only affected paths for a small batch in a large index', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    let root = await index.createEmpty();
    for (let value = 0; value < 100; value += 1) {
      root = await index.set({
        rootObjectId: root,
        entry: { key: String(value).padStart(3, '0'), value },
      });
    }
    const writesBefore = pageStore.writes;
    root = await index.deleteMany({
      rootObjectId: root,
      keys: new Set(['010', '011']),
    });

    expect(pageStore.writes - writesBefore).toBeLessThan(15);
    expect((await collect({ index, rootObjectId: root })).map(entry => entry.value)).toEqual(
      Array.from({ length: 100 }, (_, value) => value)
        .filter(value => value !== 10 && value !== 11),
    );
  });

  it('truncates the right side without deleting each key separately', async () => {
    const pageStore = new MemoryPageStore();
    const index = createIndex({ pageStore });
    let root = await index.createEmpty();
    for (let value = 0; value < 100; value += 1) {
      root = await index.set({
        rootObjectId: root,
        entry: { key: String(value).padStart(3, '0'), value },
      });
    }
    const writesBefore = pageStore.writes;
    root = await index.truncateAtOrAfter({
      rootObjectId: root,
      key: '010',
    });
    expect(pageStore.writes - writesBefore).toBeLessThan(12);
    expect((await collect({ index, rootObjectId: root })).map(entry => entry.value)).toEqual(
      Array.from({ length: 10 }, (_, index_) => index_),
    );
  });

});
