import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import type {
  StorageDirectoryHandle,
  StorageEntryHandle,
  StorageFileHandle,
  StorageFileSystemSession,
} from '@/00-storage/service/storage-file-system/types';
import { TEST_ONLY } from './api';
import type { HizoFSPolicy } from './file-system/policy';

const ROOT_KEY = new Uint8Array(32).fill(0x5a);
const MODEL_POLICY: HizoFSPolicy = {
  inlineFileByteLimit: 9,
  inlineDirectoryEntryLimit: 3,
  fileChunkSize: 5,
  indexPageEntryLimit: 3,
  readerStreamChunkSize: 4,
  maxDirtyFileBytes: 16,
  fileChunkWriteConcurrency: 2,
  metadataObjectCacheByteLimit: 64 * 1024,
  metadataObjectCacheEntryLimit: 1024,
  fileChunkCacheByteLimit: 64,
  fileChunkCacheEntryLimit: 16,
};

type ModelEntry =
  | {
      readonly kind: 'directory';
    }
  | {
      readonly kind: 'file';
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'symlink';
      readonly target: string;
    };

type ComparableEntry =
  | {
      readonly kind: 'directory';
    }
  | {
      readonly kind: 'file';
      readonly bytes: readonly number[];
    }
  | {
      readonly kind: 'symlink';
      readonly target: string;
    };

type RandomSource = {
  nextInt({ exclusiveMaximum }: {
    exclusiveMaximum: number;
  }): number;
};

type ModelOperation =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6;

function createRandomSource({ seed }: {
  seed: number;
}): RandomSource {
  let state = seed >>> 0;
  return {
    nextInt({ exclusiveMaximum }: { exclusiveMaximum: number }): number {
      if (!Number.isSafeInteger(exclusiveMaximum) || exclusiveMaximum <= 0) {
        throw new Error('exclusiveMaximum must be a positive safe integer');
      }
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state % exclusiveMaximum;
    },
  };
}

function pathToKey({ path }: {
  path: readonly string[];
}): string {
  return path.join('/');
}

function keyToPath({ key }: {
  key: string;
}): readonly string[] {
  return key.length === 0 ? [] : key.split('/');
}

function getParentKey({ key }: {
  key: string;
}): string {
  const path = keyToPath({ key });
  return pathToKey({ path: path.slice(0, -1) });
}

function getEntryName({ key }: {
  key: string;
}): string {
  const name = keyToPath({ key }).at(-1);
  if (name === undefined) {
    throw new Error('The root does not have an entry name');
  }
  return name;
}

function appendPath({ parentKey, name }: {
  parentKey: string;
  name: string;
}): string {
  return parentKey.length === 0 ? name : `${parentKey}/${name}`;
}

function getKeysByKind({ model, kind }: {
  model: ReadonlyMap<string, ModelEntry>;
  kind: ModelEntry['kind'];
}): readonly string[] {
  return [...model.entries()]
    .filter(([, entry]) => entry.kind === kind)
    .map(([key]) => key)
    .sort();
}

function choose({ values, random }: {
  values: readonly string[];
  random: RandomSource;
}): string {
  if (values.length === 0) {
    throw new Error('Cannot choose from an empty collection');
  }
  return values[random.nextInt({ exclusiveMaximum: values.length })]!;
}

function nextModelOperation({ random }: {
  random: RandomSource;
}): ModelOperation {
  switch (random.nextInt({ exclusiveMaximum: 7 })) {
  case 0:
    return 0;
  case 1:
    return 1;
  case 2:
    return 2;
  case 3:
    return 3;
  case 4:
    return 4;
  case 5:
    return 5;
  case 6:
    return 6;
  default:
    throw new Error('Random model operation is outside the expected range');
  }
}

function createBytes({ random, length }: {
  random: RandomSource;
  length: number;
}): Uint8Array {
  return Uint8Array.from(
    { length },
    () => random.nextInt({ exclusiveMaximum: 256 }),
  );
}

async function resolveDirectory({ root, key }: {
  root: StorageDirectoryHandle;
  key: string;
}): Promise<StorageDirectoryHandle> {
  let directory = root;
  for (const segment of keyToPath({ key })) {
    directory = await directory.getDirectoryHandle({
      name: segment,
      create: false,
    });
  }
  return directory;
}

async function resolveFile({ root, key }: {
  root: StorageDirectoryHandle;
  key: string;
}): Promise<StorageFileHandle> {
  const parent = await resolveDirectory({ root, key: getParentKey({ key }) });
  return parent.getFileHandle({
    name: getEntryName({ key }),
    create: false,
  });
}

async function readFileBytes({ file }: {
  file: StorageFileHandle;
}): Promise<Uint8Array> {
  const readable = await file.openReadable({ mimeType: 'application/octet-stream' });
  try {
    return new Uint8Array(await new Response(readable.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).arrayBuffer());
  } finally {
    await readable.close();
  }
}

async function snapshotActual({ session }: {
  session: StorageFileSystemSession;
}): Promise<readonly (readonly [string, ComparableEntry])[]> {
  const result = new Map<string, ComparableEntry>();
  result.set('', { kind: 'directory' });

  const visit = async ({ directory, parentKey }: {
    directory: StorageDirectoryHandle;
    parentKey: string;
  }): Promise<void> => {
    const entries: Array<readonly [string, StorageEntryHandle]> = [];
    for await (const entry of directory.entries()) {
      entries.push(entry);
    }
    entries.sort(([left], [right]) => left.localeCompare(right));

    for (const [name, handle] of entries) {
      const key = appendPath({ parentKey, name });
      switch (handle.kind) {
      case 'directory':
        result.set(key, { kind: 'directory' });
        await visit({ directory: handle, parentKey: key });
        break;
      case 'file':
        result.set(key, {
          kind: 'file',
          bytes: [...await readFileBytes({ file: handle })],
        });
        break;
      case 'symlink':
        result.set(key, {
          kind: 'symlink',
          target: await handle.readTarget(),
        });
        break;
      default: {
        const _ex: never = handle;
        throw new Error(`Unhandled storage entry: ${String(_ex)}`);
      }
      }
    }
  };

  await visit({ directory: session.root, parentKey: '' });
  return [...result.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function snapshotModel({ model }: {
  model: ReadonlyMap<string, ModelEntry>;
}): readonly (readonly [string, ComparableEntry])[] {
  return [...model.entries()]
    .map(([key, entry]): readonly [string, ComparableEntry] => {
      switch (entry.kind) {
      case 'directory':
        return [key, { kind: 'directory' }];
      case 'file':
        return [key, { kind: 'file', bytes: [...entry.bytes] }];
      case 'symlink':
        return [key, { kind: 'symlink', target: entry.target }];
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled model entry: ${String(_ex)}`);
      }
      }
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

async function expectMatchesModel({ session, model, context }: {
  session: StorageFileSystemSession;
  model: ReadonlyMap<string, ModelEntry>;
  context: string;
}): Promise<void> {
  expect(await snapshotActual({ session }), context).toEqual(snapshotModel({ model }));
}

async function createModelFile({ session, model, parentKey, name, bytes }: {
  session: StorageFileSystemSession;
  model: Map<string, ModelEntry>;
  parentKey: string;
  name: string;
  bytes: Uint8Array;
}): Promise<void> {
  const parent = await resolveDirectory({ root: session.root, key: parentKey });
  const file = await parent.getFileHandle({ name, create: true });
  const writable = await file.createWritable({ keepExistingData: false });
  await writable.write({ position: 0, data: bytes });
  await writable.close();
  model.set(appendPath({ parentKey, name }), { kind: 'file', bytes });
}

async function runModelScenario({ seed }: {
  seed: number;
}): Promise<void> {
  const backingDirectory = new MockFileSystemDirectoryHandle({ name: `backing-${seed}` });
  const random = createRandomSource({ seed });
  let clock = 0;
  const now = (): number => {
    clock += 1;
    return clock;
  };
  let session = await TEST_ONLY.createHizoFSInternal({
    backingDirectory,
    fileSystemRootKey: ROOT_KEY,
    policy: MODEL_POLICY,
    now,
  });
  const model = new Map<string, ModelEntry>([['', { kind: 'directory' }]]);
  let nextNameIndex = 0;

  const newName = ({ prefix }: { prefix: string }): string => {
    const value = `${prefix}-${String(nextNameIndex)}`;
    nextNameIndex += 1;
    return value;
  };

  for (let step = 0; step < 90; step += 1) {
    let operation = nextModelOperation({ random });
    if (model.size > 36) {
      operation = 6;
    }

    switch (operation) {
    case 0: {
      const parentKey = choose({
        values: getKeysByKind({ model, kind: 'directory' }),
        random,
      });
      const name = newName({ prefix: 'dir' });
      const parent = await resolveDirectory({ root: session.root, key: parentKey });
      await parent.getDirectoryHandle({ name, create: true });
      model.set(appendPath({ parentKey, name }), { kind: 'directory' });
      break;
    }
    case 1: {
      const parentKey = choose({
        values: getKeysByKind({ model, kind: 'directory' }),
        random,
      });
      const bytes = createBytes({
        random,
        length: random.nextInt({ exclusiveMaximum: 18 }),
      });
      await createModelFile({
        session,
        model,
        parentKey,
        name: newName({ prefix: 'file' }),
        bytes,
      });
      break;
    }
    case 2: {
      const files = getKeysByKind({ model, kind: 'file' });
      if (files.length === 0) {
        await createModelFile({
          session,
          model,
          parentKey: '',
          name: newName({ prefix: 'file' }),
          bytes: createBytes({ random, length: 4 }),
        });
        break;
      }
      const key = choose({ values: files, random });
      const current = model.get(key);
      if (current?.kind !== 'file') {
        throw new Error('Model file disappeared');
      }
      const position = random.nextInt({ exclusiveMaximum: current.bytes.byteLength + 7 });
      const data = createBytes({
        random,
        length: 1 + random.nextInt({ exclusiveMaximum: 8 }),
      });
      const file = await resolveFile({ root: session.root, key });
      const writable = await file.createWritable({ keepExistingData: true });
      await writable.write({ position, data });
      await writable.close();

      const next = new Uint8Array(Math.max(current.bytes.byteLength, position + data.byteLength));
      next.set(current.bytes);
      next.set(data, position);
      model.set(key, { kind: 'file', bytes: next });
      break;
    }
    case 3: {
      const files = getKeysByKind({ model, kind: 'file' });
      if (files.length === 0) break;
      const key = choose({ values: files, random });
      const current = model.get(key);
      if (current?.kind !== 'file') {
        throw new Error('Model file disappeared');
      }
      const size = random.nextInt({ exclusiveMaximum: current.bytes.byteLength + 7 });
      const file = await resolveFile({ root: session.root, key });
      const writable = await file.createWritable({ keepExistingData: true });
      await writable.truncate({ size });
      await writable.close();

      const next = new Uint8Array(size);
      next.set(current.bytes.subarray(0, size));
      model.set(key, { kind: 'file', bytes: next });
      break;
    }
    case 4: {
      const parentKey = choose({
        values: getKeysByKind({ model, kind: 'directory' }),
        random,
      });
      const name = newName({ prefix: 'link' });
      const target = `target-${String(random.nextInt({ exclusiveMaximum: 20 }))}`;
      const parent = await resolveDirectory({ root: session.root, key: parentKey });
      await parent.createSymlink({ name, target });
      model.set(appendPath({ parentKey, name }), { kind: 'symlink', target });
      break;
    }
    case 5: {
      const movableKeys = [...model.keys()].filter(key => key.length > 0).sort();
      if (movableKeys.length === 0) break;
      const sourceKey = choose({ values: movableKeys, random });
      const sourceEntry = model.get(sourceKey);
      if (sourceEntry === undefined) {
        throw new Error('Move source disappeared');
      }
      const directoryKeys = getKeysByKind({ model, kind: 'directory' })
        .filter((key) => (
          sourceEntry.kind !== 'directory'
          || (key !== sourceKey && !key.startsWith(`${sourceKey}/`))
        ));
      if (directoryKeys.length === 0) break;
      const destinationKey = choose({ values: directoryKeys, random });
      const destination = await resolveDirectory({ root: session.root, key: destinationKey });
      const sourceParent = await resolveDirectory({
        root: session.root,
        key: getParentKey({ key: sourceKey }),
      });
      const destinationName = newName({ prefix: 'moved' });
      await sourceParent.moveEntry({
        name: getEntryName({ key: sourceKey }),
        destination,
        newName: destinationName,
        replace: false,
      });

      const destinationRootKey = appendPath({
        parentKey: destinationKey,
        name: destinationName,
      });
      const movedEntries = [...model.entries()]
        .filter(([key]) => key === sourceKey || key.startsWith(`${sourceKey}/`));
      for (const [key] of movedEntries) {
        model.delete(key);
      }
      for (const [key, entry] of movedEntries) {
        const suffix = key.slice(sourceKey.length);
        model.set(`${destinationRootKey}${suffix}`, entry);
      }
      break;
    }
    case 6: {
      const removableKeys = [...model.keys()].filter(key => key.length > 0).sort();
      if (removableKeys.length === 0) break;
      const key = choose({ values: removableKeys, random });
      const entry = model.get(key);
      if (entry === undefined) {
        throw new Error('Remove target disappeared');
      }
      const parent = await resolveDirectory({ root: session.root, key: getParentKey({ key }) });
      await parent.removeEntry({
        name: getEntryName({ key }),
        recursive: entry.kind === 'directory',
      });
      for (const candidateKey of [...model.keys()]) {
        if (candidateKey === key || candidateKey.startsWith(`${key}/`)) {
          model.delete(candidateKey);
        }
      }
      break;
    }
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled model operation: ${String(_ex)}`);
    }
    }

    if (step % 4 === 0) {
      await expectMatchesModel({
        session,
        model,
        context: `seed=${String(seed)} step=${String(step)}`,
      });
    }
    if (step > 0 && step % 17 === 0) {
      await session.close();
      session = await TEST_ONLY.openHizoFSInternal({
        backingDirectory,
        fileSystemRootKey: ROOT_KEY,
        policy: MODEL_POLICY,
        now,
      });
      await expectMatchesModel({
        session,
        model,
        context: `seed=${String(seed)} reopened-at=${String(step)}`,
      });
    }
  }

  await expectMatchesModel({ session, model, context: `seed=${String(seed)} final` });
  await session.close();
  const reopened = await TEST_ONLY.openHizoFSInternal({
    backingDirectory,
    fileSystemRootKey: ROOT_KEY,
    policy: MODEL_POLICY,
    now,
  });
  await expectMatchesModel({ session: reopened, model, context: `seed=${String(seed)} final-reopen` });
  await reopened.close();
}

describe('HizoFS model-based file-system behavior', () => {
  for (const seed of [0x1020_3040, 0xa5a5_5a5a]) {
    it(`matches the reference model for deterministic operation seed ${String(seed)}`, async () => {
      await runModelScenario({ seed });
    }, 30_000);
  }
});
