import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CONTAINER_ROOT,
  canonicalContainerDirectory,
  canonicalContainerPath,
} from '@/00-storage/service/hizofs/physical-store/paths';
import { InMemoryCrashDurabilityBackend } from '@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend';

declare const testAuthenticatedBytesBrand: unique symbol;
type TestAuthenticatedBytes = Uint8Array & { readonly [testAuthenticatedBytesBrand]: true };

function bytes(...values: number[]): TestAuthenticatedBytes {
  return Uint8Array.from(values) as TestAuthenticatedBytes;
}

function createBackend(): InMemoryCrashDurabilityBackend<TestAuthenticatedBytes> {
  return new InMemoryCrashDurabilityBackend<TestAuthenticatedBytes>({ maximumFileByteLength: 1024n });
}

describe('HizoFS in-memory durability model', () => {
  it('requires both file-data durability and parent-entry durability for a new file', async () => {
    const backend = createBackend();
    const path = canonicalContainerPath({ value: 'superblock-0.enc' });
    const file = await backend.createFileExclusive({ path });
    await backend.writeAt({ file, offset: 0n, bytes: bytes(1, 2, 3) });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });

    await backend.crashAndRecover();
    expect(await backend.getFileSize({ path })).toBeUndefined();

    const recreated = await backend.createFileExclusive({ path });
    await backend.writeAt({ file: recreated, offset: 0n, bytes: bytes(4, 5) });
    await backend.syncFileData({ file: recreated });
    await backend.syncDirectoryEntries({ parent: CANONICAL_CONTAINER_ROOT });
    await backend.closeFile({ file: recreated });
    await backend.crashAndRecover();
    expect(await backend.readFileBounded({ path, maximumByteLength: 2 })).toEqual(bytes(4, 5));
  });

  it('rolls back non-durable updates to the last durable file bytes', async () => {
    const backend = createBackend();
    const path = canonicalContainerPath({ value: 'superblock-0.enc' });
    const file = await backend.createFileExclusive({ path });
    await backend.writeAt({ file, offset: 0n, bytes: bytes(1, 2, 3) });
    await backend.syncFileData({ file });
    await backend.syncDirectoryEntries({ parent: CANONICAL_CONTAINER_ROOT });
    await backend.writeAt({ file, offset: 0n, bytes: bytes(9, 9, 9) });
    await backend.closeFile({ file });

    await backend.crashAndRecover();
    expect(await backend.readExact({ path, offset: 0n, length: 3 })).toEqual(bytes(1, 2, 3));
  });

  it('persists nested directory entries independently at each parent boundary', async () => {
    const backend = createBackend();
    const segments = canonicalContainerDirectory({ value: 'segments' });
    const metadata = canonicalContainerDirectory({ value: 'segments/metadata' });
    const path = canonicalContainerPath({ value: 'segments/metadata/record.enc' });

    await backend.createDirectoryExclusive({ path: segments });
    await backend.syncDirectoryEntries({ parent: CANONICAL_CONTAINER_ROOT });
    await backend.createDirectoryExclusive({ path: metadata });
    await backend.syncDirectoryEntries({ parent: segments });
    const file = await backend.createFileExclusive({ path });
    await backend.writeAt({ file, offset: 0n, bytes: bytes(7) });
    await backend.syncFileData({ file });
    await backend.closeFile({ file });

    await backend.crashAndRecover();
    expect(await backend.getFileSize({ path })).toBeUndefined();
    expect(await backend.list({ directory: metadata })).toEqual([]);
  });

  it('requires parent durability after removal and invalidates all handles on crash', async () => {
    const backend = createBackend();
    const path = canonicalContainerPath({ value: 'unlock-0.json' });
    const file = await backend.createFileExclusive({ path });
    await backend.writeAt({ file, offset: 0n, bytes: bytes(1) });
    await backend.syncFileData({ file });
    await backend.syncDirectoryEntries({ parent: CANONICAL_CONTAINER_ROOT });
    await backend.closeFile({ file });

    const update = await backend.openFileForUpdate({ path });
    await backend.closeFile({ file: update });
    await backend.removeFile({ path });
    await backend.crashAndRecover();
    expect(await backend.getFileSize({ path })).toBe(1n);

    const stale = await backend.openFileForUpdate({ path });
    await backend.crashAndRecover();
    await expect(backend.truncate({ file: stale, length: 0n })).rejects.toMatchObject({ code: 'closed_handle' });

    const current = await backend.openFileForUpdate({ path });
    await backend.closeFile({ file: current });
    await backend.removeFile({ path });
    await backend.syncDirectoryEntries({ parent: CANONICAL_CONTAINER_ROOT });
    await backend.crashAndRecover();
    expect(await backend.getFileSize({ path })).toBeUndefined();
  });
});
