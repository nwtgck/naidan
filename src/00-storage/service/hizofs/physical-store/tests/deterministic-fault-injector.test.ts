import { describe, expect, it } from 'vitest';
import { CANONICAL_CONTAINER_ROOT, canonicalContainerPath } from '@/00-storage/service/hizofs/physical-store/paths';
import {
  DeterministicPhysicalStoreFaultInjector,
  InjectedPhysicalStoreFault,
} from '@/00-storage/service/hizofs/physical-store/testing/deterministic-fault-injector';
import { InMemoryCrashDurabilityBackend } from '@/00-storage/service/hizofs/physical-store/testing/in-memory-crash-durability-backend';

declare const testAuthenticatedBytesBrand: unique symbol;
type TestAuthenticatedBytes = Uint8Array & { readonly [testAuthenticatedBytesBrand]: true };

function bytes(...values: number[]): TestAuthenticatedBytes {
  return Uint8Array.from(values) as TestAuthenticatedBytes;
}

describe('deterministic physical-store fault injection', () => {
  it('injects only the exact configured point and occurrence', () => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 2, operation: 'writeAt', timing: 'before' }],
    });
    expect(() => injector.checkpoint({ operation: 'writeAt', timing: 'before' })).not.toThrow();
    expect(() => injector.checkpoint({ operation: 'readExact', timing: 'before' })).not.toThrow();
    expect(() => injector.checkpoint({ operation: 'writeAt', timing: 'before' })).toThrow(InjectedPhysicalStoreFault);
    expect(injector.pendingFaults()).toEqual([]);
    expect(() => injector.assertExhausted()).not.toThrow();
  });

  it('reports schedule entries that were never reached', () => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 3, operation: 'truncate', timing: 'after' }],
    });
    expect(() => injector.assertExhausted()).toThrow('truncate:after:3');
  });

  it('closes a handle acquired by an operation that faults after acquisition', async () => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 1, operation: 'createFileExclusive', timing: 'after' }],
    });
    const backend = new InMemoryCrashDurabilityBackend<TestAuthenticatedBytes>({ faultInjector: injector, maximumFileByteLength: 1024n });
    const path = canonicalContainerPath({ value: 'superblock-0.enc' });

    await expect(backend.createFileExclusive({ path })).rejects.toBeInstanceOf(InjectedPhysicalStoreFault);
    const recoveredHandle = await backend.openFileForUpdate({ path });
    await backend.closeFile({ file: recoveredHandle });
    expect(backend.openHandleCount()).toBe(0);
  });

  it('models before-versus-after durability faults as different recoverable outcomes', async () => {
    const beforeInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 1, operation: 'syncFileData', timing: 'before' }],
    });
    const beforeBackend = new InMemoryCrashDurabilityBackend<TestAuthenticatedBytes>({ faultInjector: beforeInjector, maximumFileByteLength: 1024n });
    const beforePath = canonicalContainerPath({ value: 'before.enc' });
    const beforeFile = await beforeBackend.createFileExclusive({ path: beforePath });
    await beforeBackend.writeAt({ file: beforeFile, offset: 0n, bytes: bytes(1) });
    await expect(beforeBackend.syncFileData({ file: beforeFile })).rejects.toBeInstanceOf(InjectedPhysicalStoreFault);
    await beforeBackend.syncDirectoryEntries({ parent: CANONICAL_CONTAINER_ROOT });
    await beforeBackend.closeFile({ file: beforeFile });
    await beforeBackend.crashAndRecover();
    expect(await beforeBackend.readFileBounded({ path: beforePath, maximumByteLength: 1 })).toEqual(new Uint8Array());

    const afterInjector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 1, operation: 'syncFileData', timing: 'after' }],
    });
    const afterBackend = new InMemoryCrashDurabilityBackend<TestAuthenticatedBytes>({ faultInjector: afterInjector, maximumFileByteLength: 1024n });
    const afterPath = canonicalContainerPath({ value: 'after.enc' });
    const afterFile = await afterBackend.createFileExclusive({ path: afterPath });
    await afterBackend.writeAt({ file: afterFile, offset: 0n, bytes: bytes(2) });
    await expect(afterBackend.syncFileData({ file: afterFile })).rejects.toBeInstanceOf(InjectedPhysicalStoreFault);
    await afterBackend.syncDirectoryEntries({ parent: CANONICAL_CONTAINER_ROOT });
    await afterBackend.closeFile({ file: afterFile });
    await afterBackend.crashAndRecover();
    expect(await afterBackend.readFileBounded({ path: afterPath, maximumByteLength: 1 })).toEqual(bytes(2));
  });

  it('keeps close retry-safe when the injected error occurs after close', async () => {
    const injector = new DeterministicPhysicalStoreFaultInjector({
      schedule: [{ occurrence: 1, operation: 'closeFile', timing: 'after' }],
    });
    const backend = new InMemoryCrashDurabilityBackend<TestAuthenticatedBytes>({ faultInjector: injector, maximumFileByteLength: 1024n });
    const file = await backend.createFileExclusive({ path: canonicalContainerPath({ value: 'copy.enc' }) });

    await expect(backend.closeFile({ file })).rejects.toBeInstanceOf(InjectedPhysicalStoreFault);
    await expect(backend.closeFile({ file })).resolves.toBeUndefined();
    expect(backend.openHandleCount()).toBe(0);
  });
});
