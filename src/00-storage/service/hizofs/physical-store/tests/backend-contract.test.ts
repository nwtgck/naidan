import { describe, expect, it } from 'vitest';
import {
  hasCrashDurableWritableSemantics,
  type HizoFSPhysicalWriteBackend,
} from '@/00-storage/service/hizofs/physical-store/backend';
import {
  CANONICAL_CONTAINER_ROOT,
  canonicalContainerDirectory,
  canonicalContainerPath,
  parentContainerDirectory,
} from '@/00-storage/service/hizofs/physical-store/paths';
import { PhysicalStoreError } from '@/00-storage/service/hizofs/physical-store/errors';
import { InMemoryCrashDurabilityBackend } from '@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend';

declare const testAuthenticatedBytesBrand: unique symbol;
type TestAuthenticatedBytes = Uint8Array & { readonly [testAuthenticatedBytesBrand]: true };

function authenticatedBytes({ values }: { values: readonly number[] }): TestAuthenticatedBytes {
  return Uint8Array.from(values) as TestAuthenticatedBytes;
}

function createBackend(): InMemoryCrashDurabilityBackend<TestAuthenticatedBytes> {
  return new InMemoryCrashDurabilityBackend<TestAuthenticatedBytes>({ maximumFileByteLength: 1024n });
}

describe('HizoFS physical-store backend contract', () => {
  it('does not promote unproven parent-entry durability to strong writable use', () => {
    const backend = createBackend();
    expect(hasCrashDurableWritableSemantics(backend)).toBe(true);

    const unprovenBackend = Object.assign(
      Object.create(backend) as HizoFSPhysicalWriteBackend<TestAuthenticatedBytes>,
      {
        capabilities: {
          directoryEntryDurability: 'not-demonstrated' as const,
          fileDataDurability: 'crash-durable' as const,
        },
      },
    );
    expect(hasCrashDurableWritableSemantics(unprovenBackend)).toBe(false);
  });

  it('accepts only traversal-safe relative paths and keeps root distinct from files', () => {
    expect(CANONICAL_CONTAINER_ROOT).toBe('');
    expect(canonicalContainerDirectory({ value: 'segments/metadata' })).toBe('segments/metadata');
    expect(canonicalContainerPath({ value: 'superblock-0.enc' })).toBe('superblock-0.enc');
    expect(parentContainerDirectory({ path: canonicalContainerPath({ value: 'segments/data/af/file.enc' }) })).toBe('segments/data/af');

    for (const value of ['', '/absolute', 'trailing/', 'a//b', 'a/../b', 'a/./b', 'a\\b', 'a\0b']) {
      expect(() => canonicalContainerPath({ value })).toThrow();
    }
    expect(() => canonicalContainerDirectory({ value: '/segments' })).toThrow();
    expect(() => canonicalContainerPath({ value: `${'a'.repeat(256)}/file` })).toThrow('255');
    expect(canonicalContainerPath({ value: `${'a'.repeat(200)}/${'b'.repeat(200)}` })).toHaveLength(401);
  });

  it('distinguishes missing files from present empty files and enforces exclusive creation', async () => {
    const backend = createBackend();
    const directory = canonicalContainerDirectory({ value: 'segments' });
    const path = canonicalContainerPath({ value: 'segments/empty.enc' });

    expect(await backend.readFileBounded({ path, maximumByteLength: 0 })).toBeUndefined();
    await expect(backend.createDirectoryExclusive({ path: directory })).resolves.toEqual({ parentEntrySyncRequired: true });
    await expect(backend.createDirectoryExclusive({ path: directory })).resolves.toEqual({ parentEntrySyncRequired: false });
    const file = await backend.createFileExclusive({ path });
    expect(await backend.readFileBounded({ path, maximumByteLength: 0 })).toEqual(new Uint8Array());
    await expect(backend.createFileExclusive({ path })).rejects.toMatchObject({ code: 'already_exists' });
    await backend.closeFile({ file });
  });

  it('supports exact reads, bounded whole-file reads, sparse extension, and truncation without aliasing', async () => {
    const backend = createBackend();
    const path = canonicalContainerPath({ value: 'copy.enc' });
    const file = await backend.createFileExclusive({ path });
    const source = authenticatedBytes({ values: [1, 2, 3] });
    await backend.writeAt({ file, offset: 2n, bytes: source });
    source.fill(9);

    expect(await backend.getFileSize({ path })).toBe(5n);
    expect(await backend.getOpenFileSize({ file })).toBe(5n);
    expect(await backend.readExact({ path, offset: 0n, length: 5 })).toEqual(Uint8Array.from([0, 0, 1, 2, 3]));
    expect(await backend.readExactWithFileSize({ path, offset: 1n, length: 3 })).toEqual({
      bytes: Uint8Array.from([0, 1, 2]),
      fileSize: 5n,
    });
    await expect(backend.readExact({ path, offset: 4n, length: 2 })).rejects.toMatchObject({ code: 'unexpected_end' });
    await expect(backend.readExactWithFileSize({ path, offset: 4n, length: 2 })).rejects.toMatchObject({ code: 'unexpected_end' });
    await expect(backend.readFileBounded({ path, maximumByteLength: 4 })).rejects.toMatchObject({ code: 'file_too_large' });

    await backend.writeAt({ file, offset: 10n, bytes: authenticatedBytes({ values: [] }) });
    expect(await backend.getFileSize({ path })).toBe(5n);
    await backend.truncate({ file, length: 2n });
    expect(await backend.readFileBounded({ path, maximumByteLength: 2 })).toEqual(Uint8Array.from([0, 0]));
    await backend.truncate({ file, length: 4n });
    expect(await backend.getOpenFileSize({ file })).toBe(4n);
    expect(await backend.readExact({ path, offset: 0n, length: 4 })).toEqual(Uint8Array.from([0, 0, 0, 0]));
    await backend.closeFile({ file });
    await expect(backend.getOpenFileSize({ file })).rejects.toMatchObject({ code: 'closed_handle' });
  });

  it('sorts directory entries and reports file sizes without exposing mutable storage', async () => {
    const backend = createBackend();
    const directory = canonicalContainerDirectory({ value: 'segments' });
    await backend.createDirectoryExclusive({ path: directory });
    const fileB = await backend.createFileExclusive({ path: canonicalContainerPath({ value: 'segments/b.enc' }) });
    const fileA = await backend.createFileExclusive({ path: canonicalContainerPath({ value: 'segments/a.enc' }) });
    await backend.writeAt({ file: fileB, offset: 0n, bytes: authenticatedBytes({ values: [1, 2] }) });

    expect(await backend.list({ directory })).toEqual([
      { byteLength: 0n, kind: 'file', name: 'a.enc' },
      { byteLength: 2n, kind: 'file', name: 'b.enc' },
    ]);
    await backend.closeFile({ file: fileA });
    await backend.closeFile({ file: fileB });
  });

  it('traverses directories through bounded stateful pages without making entry order authoritative', async () => {
    const backend = createBackend();
    const directory = canonicalContainerDirectory({ value: 'segments' });
    await backend.createDirectoryExclusive({ path: directory });
    const handles = await Promise.all(['b.enc', 'a.enc', 'c.enc'].map(async name => await backend.createFileExclusive({
      path: canonicalContainerPath({ value: `segments/${name}` }),
    })));
    await backend.writeAt({ file: handles[0]!, offset: 0n, bytes: authenticatedBytes({ values: [1, 2] }) });

    const cursor = await backend.openDirectoryCursor({ directory });
    const first = await cursor.read({ maximumEntries: 2 });
    const second = await cursor.read({ maximumEntries: 2 });
    const entries = [...first.entries, ...second.entries];
    expect(first).toMatchObject({ done: false });
    expect(first.entries).toHaveLength(2);
    expect(second).toMatchObject({ done: true });
    expect(entries.map(entry => entry.name).sort()).toEqual(['a.enc', 'b.enc', 'c.enc']);
    expect(entries.find(entry => entry.name === 'b.enc')).toMatchObject({ byteLength: 2n, kind: 'file' });
    expect(await cursor.read({ maximumEntries: 1 })).toEqual({ done: true, entries: [] });
    await cursor.close();
    await cursor.close();
    await expect(cursor.read({ maximumEntries: 1 })).rejects.toThrow('closed');

    const invalid = await backend.openDirectoryCursor({ directory });
    await expect(invalid.read({ maximumEntries: 0 })).rejects.toThrow('positive safe integer');
    await invalid.close();
    await Promise.all(handles.map(async file => await backend.closeFile({ file })));
  });

  it('rejects closed, foreign, and still-open removal handles', async () => {
    const first = createBackend();
    const second = createBackend();
    const path = canonicalContainerPath({ value: 'superblock-0.enc' });
    const file = await first.createFileExclusive({ path });

    await expect(first.removeFile({ path })).rejects.toMatchObject({ code: 'file_open' });
    await expect(second.writeAt({ file, offset: 0n, bytes: authenticatedBytes({ values: [1] }) })).rejects.toMatchObject({ code: 'foreign_handle' });
    await first.closeFile({ file });
    await first.closeFile({ file });
    await expect(first.writeAt({ file, offset: 0n, bytes: authenticatedBytes({ values: [1] }) })).rejects.toMatchObject({ code: 'closed_handle' });
    await first.removeFile({ path });
    expect(await first.getFileSize({ path })).toBeUndefined();
  });

  it('uses typed physical-store errors rather than guessing conflicting entry kinds', async () => {
    const backend = createBackend();
    const filePath = canonicalContainerPath({ value: 'segments' });
    const file = await backend.createFileExclusive({ path: filePath });
    await backend.closeFile({ file });

    try {
      await backend.createDirectoryExclusive({ path: canonicalContainerDirectory({ value: 'segments' }) });
      expect.unreachable('expected kind conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(PhysicalStoreError);
      expect(error).toMatchObject({ code: 'not_directory' });
    }
  });
});
