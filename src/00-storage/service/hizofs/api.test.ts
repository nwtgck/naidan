import { describe, expect, it } from 'vitest';
import { MockFileSystemDirectoryHandle } from '@/utils/in-memory-file-system';
import {
  readStorageFileText,
  writeStorageFileText,
} from '@/00-storage/service/storage-file-system/io';
import type { StorageFileSystemSession } from '@/00-storage/service/storage-file-system/types';
import {
  createHizoFS,
  inspectHizoFS,
  openHizoFS,
  TEST_ONLY,
} from './api';
import type { HizoFSPolicy } from './file-system/policy';

const ROOT_KEY = new Uint8Array(32).fill(9);
const TINY_POLICY: HizoFSPolicy = {
  inlineFileByteLimit: 8,
  inlineDirectoryEntryLimit: 2,
  fileChunkSize: 4,
  indexPageEntryLimit: 2,
  readerStreamChunkSize: 3,
};

async function createTiny({ root, now }: {
  root: FileSystemDirectoryHandle;
  now: () => number;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.createHizoFSInternal({
    backingDirectory: root,
    fileSystemRootKey: ROOT_KEY,
    policy: TINY_POLICY,
    now,
  });
}

async function openTiny({ root, now }: {
  root: FileSystemDirectoryHandle;
  now: () => number;
}): Promise<StorageFileSystemSession> {
  return TEST_ONLY.openHizoFSInternal({
    backingDirectory: root,
    fileSystemRootKey: ROOT_KEY,
    policy: TINY_POLICY,
    now,
  });
}

async function readBytes({ session, path }: {
  session: StorageFileSystemSession;
  path: readonly string[];
}): Promise<Uint8Array> {
  let directory = session.root;
  for (const segment of path.slice(0, -1)) {
    directory = await directory.getDirectoryHandle({ name: segment, create: false });
  }
  const name = path.at(-1);
  if (name === undefined) throw new Error('Path must include a file name');
  const file = await directory.getFileHandle({ name, create: false });
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

async function copyNativeDirectory({ source, destination }: {
  source: FileSystemDirectoryHandle;
  destination: FileSystemDirectoryHandle;
}): Promise<void> {
  for await (const [name, handle] of source.entries()) {
    switch (handle.kind) {
    case 'file': {
      const sourceFile = await (handle as FileSystemFileHandle).getFile();
      const targetFile = await destination.getFileHandle(name, { create: true });
      const writable = await targetFile.createWritable({ keepExistingData: false });
      await writable.write(sourceFile);
      await writable.close();
      break;
    }
    case 'directory': {
      const targetDirectory = await destination.getDirectoryHandle(name, { create: true });
      await copyNativeDirectory({
        source: handle as FileSystemDirectoryHandle,
        destination: targetDirectory,
      });
      break;
    }
    default: {
      const _ex: never = handle;
      throw new Error(`Unhandled backing entry: ${String(_ex)}`);
    }
    }
  }
}

describe('HizoFS public file-system API', () => {
  it('creates one file system inside exactly the provided backing directory', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'dedicated-backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });

    const physicalNames: string[] = [];
    for await (const [name] of backing.entries()) physicalNames.push(name);
    expect(physicalNames.sort()).toEqual([
      'descriptor.json',
      'objects',
      'superblock-0.enc',
    ]);
    expect(session.capabilities).toEqual({
      directBlob: 'unsupported',
      symbolicLink: 'supported',
      atomicMove: 'supported',
    });
  });


  it('opens byte-identical persisted data under renamed and moved backing directories', async () => {
    const nativeRoot = new MockFileSystemDirectoryHandle({ name: 'opfs-root' });
    const canonical = await nativeRoot.getDirectoryHandle('filesystem.hizofs', { create: true });
    const created = await createHizoFS({
      backingDirectory: canonical,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await created.root.getFileHandle({ name: 'proof.txt', create: true }),
      value: 'directory names are not format identity',
    });
    await created.close();

    // Native OPFS does not expose directory rename. Copying the exact physical bytes
    // into differently named handles verifies that names and suffixes do not participate
    // in format identity, key derivation, AAD, or object addressing.
    const noSuffix = await nativeRoot.getDirectoryHandle('filesystem', { create: true });
    const unrelatedSuffix = await nativeRoot.getDirectoryHandle('filesystem.anything', {
      create: true,
    });
    const movedParent = await nativeRoot.getDirectoryHandle('moved-parent', { create: true });
    const movedAndRenamed = await movedParent.getDirectoryHandle('renamed-store', { create: true });

    for (const destination of [noSuffix, unrelatedSuffix, movedAndRenamed]) {
      await copyNativeDirectory({ source: canonical, destination });
      const reopened = await openHizoFS({
        backingDirectory: destination,
        fileSystemRootKey: ROOT_KEY,
      });
      expect(await readStorageFileText({
        fileHandle: await reopened.root.getFileHandle({ name: 'proof.txt', create: false }),
      })).toBe('directory names are not format identity');
      await reopened.close();
    }
  });

  it('does not recognize an empty directory merely because it uses the canonical suffix', async () => {
    const emptyCanonicalName = new MockFileSystemDirectoryHandle({ name: 'filesystem.hizofs' });
    await expect(openHizoFS({
      backingDirectory: emptyCanonicalName,
      fileSystemRootKey: ROOT_KEY,
    })).rejects.toThrow('HizoFS descriptor is missing');
  });

  it('round-trips an inline file across a complete reopen', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const first = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const file = await first.root.getFileHandle({ name: 'settings.json', create: true });
    await writeStorageFileText({ fileHandle: file, value: '{"ok":true}' });
    await first.close();

    const second = await openHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    const reopened = await second.root.getFileHandle({ name: 'settings.json', create: false });
    expect(await readStorageFileText({ fileHandle: reopened })).toBe('{"ok":true}');
    expect((await reopened.openReadable({ mimeType: 'application/json' })).backing).toEqual({
      type: 'reader_only',
    });
  });

  it('inspects the authenticated descriptor, superblock, and active commit', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });
    await writeStorageFileText({
      fileHandle: await session.root.getFileHandle({ name: 'settings.json', create: true }),
      value: '{"ok":true}',
    });

    const inspection = await inspectHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
    });

    expect(inspection.descriptor.formatVersion).toBe(1);
    expect(inspection.superblock.fileSystemId).toBe(inspection.descriptor.fileSystemId);
    expect(inspection.superblock.activeCommitObjectId).toBe(inspection.activeCommitObjectId);
    expect(inspection.activeCommit.revision).toBe(2);
    expect(inspection.activeCommit.rootDirectoryNodeId).toBeTruthy();
  });

  it('fails closed when opened with the wrong root key', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    await createHizoFS({ backingDirectory: backing, fileSystemRootKey: ROOT_KEY });
    await expect(openHizoFS({
      backingDirectory: backing,
      fileSystemRootKey: new Uint8Array(32).fill(10),
    })).rejects.toThrow();
  });

  it('supports extent-backed random writes, truncate, and sparse zero ranges', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 100 });
    const file = await session.root.getFileHandle({ name: 'large.bin', create: true });
    const writer = await file.createWritable({ keepExistingData: false });
    await writer.write({ position: 10, data: new Uint8Array([7, 8]) });
    await writer.write({ position: 1, data: new Uint8Array([1, 2, 3, 4, 5]) });
    await writer.truncate({ size: 11 });
    await writer.close();

    expect([...await readBytes({ session, path: ['large.bin'] })]).toEqual([
      0, 1, 2, 3, 4, 5, 0, 0, 0, 0, 7,
    ]);
    expect(await file.stat()).toMatchObject({ size: 11, modifiedAt: 100 });

    await session.close();
    const reopened = await openTiny({ root: backing, now: () => 200 });
    expect([...await readBytes({ session: reopened, path: ['large.bin'] })]).toEqual([
      0, 1, 2, 3, 4, 5, 0, 0, 0, 0, 7,
    ]);
  });

  it('preserves every inline byte when a later append converts the file to extents', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const file = await session.root.getFileHandle({ name: 'inline-to-extents.bin', create: true });
    const inlineWriter = await file.createWritable({ keepExistingData: false });
    await inlineWriter.write({
      position: 0,
      data: new TextEncoder().encode('1234567'),
    });
    await inlineWriter.close();

    const extentWriter = await file.createWritable({ keepExistingData: true });
    await extentWriter.write({
      position: 7,
      data: new TextEncoder().encode('89ABC'),
    });
    await extentWriter.close();

    expect(new TextDecoder().decode(await readBytes({
      session,
      path: ['inline-to-extents.bin'],
    }))).toBe('123456789ABC');
    await session.close();
  });

  it('uses the persisted chunk size when a later implementation policy changes', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const first = await createTiny({ root: backing, now: () => 1 });
    const file = await first.root.getFileHandle({ name: 'policy.bin', create: true });
    const initial = new TextEncoder().encode('abcdefghijklmnop');
    const firstWriter = await file.createWritable({ keepExistingData: false });
    await firstWriter.write({ position: 0, data: initial });
    await firstWriter.close();
    await first.close();

    const changedPolicy: HizoFSPolicy = {
      ...TINY_POLICY,
      fileChunkSize: 7,
    };
    const second = await TEST_ONLY.openHizoFSInternal({
      backingDirectory: backing,
      fileSystemRootKey: ROOT_KEY,
      policy: changedPolicy,
      now: () => 2,
    });
    const reopened = await second.root.getFileHandle({ name: 'policy.bin', create: false });
    const secondWriter = await reopened.createWritable({ keepExistingData: true });
    await secondWriter.write({ position: 5, data: new TextEncoder().encode('XYZ') });
    await secondWriter.close();

    expect(new TextDecoder().decode(await readBytes({
      session: second,
      path: ['policy.bin'],
    }))).toBe('abcdeXYZijklmnop');
    await second.close();
  });

  it('keeps an open reader on its immutable snapshot after a later overwrite', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const session = await createTiny({ root: backing, now: () => 1 });
    const file = await session.root.getFileHandle({ name: 'snapshot.txt', create: true });
    await writeStorageFileText({ fileHandle: file, value: 'old-value-which-is-large' });
    const reader = await file.openReadable({ mimeType: 'text/plain' });
    await writeStorageFileText({ fileHandle: file, value: 'new-value-which-is-large' });

    expect(await new Response(reader.stream({
      start: 0,
      end: undefined,
      signal: undefined,
    })).text()).toBe('old-value-which-is-large');
    expect(await readStorageFileText({ fileHandle: file })).toBe('new-value-which-is-large');
  });

  it('rejects the second writer when the file revision changed', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const file = await session.root.getFileHandle({ name: 'conflict.bin', create: true });
    const first = await file.createWritable({ keepExistingData: true });
    const second = await file.createWritable({ keepExistingData: true });
    await first.write({ position: 0, data: new Uint8Array([1]) });
    await second.write({ position: 0, data: new Uint8Array([2]) });
    await first.close();
    await expect(second.close()).rejects.toThrow('changed while its writer was open');
    expect([...await readBytes({ session, path: ['conflict.bin'] })]).toEqual([1]);
  });


  it('serializes mutations from separate sessions without losing either root update', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const first = await createTiny({ root: backing, now: () => 1 });
    const second = await openTiny({ root: backing, now: () => 2 });

    await Promise.all([
      first.root.getFileHandle({ name: 'from-first', create: true }),
      second.root.getFileHandle({ name: 'from-second', create: true }),
    ]);
    await first.close();
    await second.close();

    const reopened = await openTiny({ root: backing, now: () => 3 });
    await expect(reopened.root.getFileHandle({
      name: 'from-first',
      create: false,
    })).resolves.toBeDefined();
    await expect(reopened.root.getFileHandle({
      name: 'from-second',
      create: false,
    })).resolves.toBeDefined();
    await reopened.close();
  });

  it('rejects a writer from another session after the file revision changes', async () => {
    const backing = new MockFileSystemDirectoryHandle({ name: 'backing' });
    const firstSession = await createTiny({ root: backing, now: () => 1 });
    const initialFile = await firstSession.root.getFileHandle({ name: 'shared.bin', create: true });
    await writeStorageFileText({ fileHandle: initialFile, value: 'initial' });
    const secondSession = await openTiny({ root: backing, now: () => 2 });
    const firstFile = await firstSession.root.getFileHandle({ name: 'shared.bin', create: false });
    const secondFile = await secondSession.root.getFileHandle({ name: 'shared.bin', create: false });
    const firstWriter = await firstFile.createWritable({ keepExistingData: true });
    const secondWriter = await secondFile.createWritable({ keepExistingData: true });

    await firstWriter.write({ position: 0, data: new TextEncoder().encode('winner') });
    await secondWriter.write({ position: 0, data: new TextEncoder().encode('loser!') });
    await firstWriter.close();
    await expect(secondWriter.close()).rejects.toThrow('changed while its writer was open');
    expect(await readStorageFileText({ fileHandle: firstFile })).toBe('winnerl');
    await firstSession.close();
    await secondSession.close();
  });

  it('rejects moving a directory into its descendant without changing the tree', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const parent = await session.root.getDirectoryHandle({ name: 'parent', create: true });
    const child = await parent.getDirectoryHandle({ name: 'child', create: true });
    await parent.getFileHandle({ name: 'value.txt', create: true });

    await expect(session.root.moveEntry({
      name: 'parent',
      destination: child,
      newName: 'nested-parent',
      replace: false,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await expect(session.root.getDirectoryHandle({
      name: 'parent',
      create: false,
    })).resolves.toBeDefined();
    await expect(child.getDirectoryHandle({
      name: 'nested-parent',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
    await session.close();
  });

  it('atomically replaces compatible entries and rejects unsafe replacements', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const source = await session.root.getDirectoryHandle({ name: 'source', create: true });
    const destination = await session.root.getDirectoryHandle({ name: 'destination', create: true });
    await writeStorageFileText({
      fileHandle: await source.getFileHandle({ name: 'incoming.txt', create: true }),
      value: 'incoming',
    });
    await writeStorageFileText({
      fileHandle: await destination.getFileHandle({ name: 'target.txt', create: true }),
      value: 'old-target',
    });

    await source.moveEntry({
      name: 'incoming.txt',
      destination,
      newName: 'target.txt',
      replace: true,
    });
    expect(await readStorageFileText({
      fileHandle: await destination.getFileHandle({ name: 'target.txt', create: false }),
    })).toBe('incoming');
    await expect(source.getFileHandle({
      name: 'incoming.txt',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });

    const sourceFile = await source.getFileHandle({ name: 'file', create: true });
    const targetDirectory = await destination.getDirectoryHandle({ name: 'entry', create: true });
    await expect(source.moveEntry({
      name: 'file',
      destination,
      newName: 'entry',
      replace: true,
    })).rejects.toMatchObject({ name: 'TypeMismatchError' });
    await expect(source.getFileHandle({ name: 'file', create: false })).resolves.toMatchObject({
      kind: sourceFile.kind,
      name: sourceFile.name,
    });
    await expect(destination.getDirectoryHandle({
      name: 'entry',
      create: false,
    })).resolves.toMatchObject({
      kind: targetDirectory.kind,
      name: targetDirectory.name,
    });

    const sourceDirectory = await source.getDirectoryHandle({ name: 'directory', create: true });
    await destination.getDirectoryHandle({ name: 'non-empty', create: true }).then(
      async directory => await directory.getFileHandle({ name: 'child', create: true }),
    );
    await expect(source.moveEntry({
      name: 'directory',
      destination,
      newName: 'non-empty',
      replace: true,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await expect(source.getDirectoryHandle({
      name: 'directory',
      create: false,
    })).resolves.toMatchObject({
      kind: sourceDirectory.kind,
      name: sourceDirectory.name,
    });
    await session.close();
  });

  it('creates directories and symlinks and atomically moves a stable file between directories', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const from = await session.root.getDirectoryHandle({ name: 'from', create: true });
    const to = await session.root.getDirectoryHandle({ name: 'to', create: true });
    const file = await from.getFileHandle({ name: 'before.txt', create: true });
    await writeStorageFileText({ fileHandle: file, value: 'payload' });
    const link = await from.createSymlink({ name: 'link', target: 'before.txt' });
    expect(await link.readTarget()).toBe('before.txt');

    await from.moveEntry({
      name: 'before.txt',
      destination: to,
      newName: 'after.txt',
      replace: false,
    });
    await expect(from.getFileHandle({ name: 'before.txt', create: false })).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    expect(await readStorageFileText({
      fileHandle: await to.getFileHandle({ name: 'after.txt', create: false }),
    })).toBe('payload');
  });

  it('converts a large directory to an indexed representation without changing enumeration semantics', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const directory = await session.root.getDirectoryHandle({ name: 'many', create: true });
    for (const name of ['z', 'a', 'm', 'b', 'y']) {
      await directory.getFileHandle({ name, create: true });
    }
    const names: string[] = [];
    for await (const [name] of directory.entries()) names.push(name);
    expect(names).toEqual(['a', 'b', 'm', 'y', 'z']);
  });

  it('enforces non-recursive directory deletion and removes complete subtrees recursively', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const parent = await session.root.getDirectoryHandle({ name: 'parent', create: true });
    const child = await parent.getDirectoryHandle({ name: 'child', create: true });
    await child.getFileHandle({ name: 'value', create: true });

    await expect(session.root.removeEntry({
      name: 'parent',
      recursive: false,
    })).rejects.toMatchObject({ name: 'InvalidModificationError' });
    await session.root.removeEntry({ name: 'parent', recursive: true });
    await expect(session.root.getDirectoryHandle({
      name: 'parent',
      create: false,
    })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('invalidates handles when their session is closed', async () => {
    const session = await createTiny({
      root: new MockFileSystemDirectoryHandle({ name: 'backing' }),
      now: () => 1,
    });
    const root = session.root;
    await session.close();
    await expect(root.getFileHandle({ name: 'x', create: true })).rejects.toThrow(
      'session is closed',
    );
  });
});
