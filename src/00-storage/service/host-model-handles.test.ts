// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles } from './host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';

function databaseHarness({ value }: { value: unknown }) {
  const stored = { value, key: undefined as IDBValidKey | undefined };
  const request = { result: value, error: undefined as DOMException | undefined };
  const store = {
    get: vi.fn(() => request),
    put: vi.fn((handle: unknown, key: IDBValidKey) => {
      stored.value = handle; stored.key = key; return request;
    }),
    delete: vi.fn((key: IDBValidKey) => {
      stored.key = key; return request;
    }),
  };
  const transaction = {
    objectStore: vi.fn(() => store), error: undefined as DOMException | undefined,
    oncomplete: undefined as (() => void) | undefined,
    onabort: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
  };
  const database = { transaction: vi.fn(() => transaction), close: vi.fn(), onversionchange: undefined as (() => void) | undefined };
  const open = vi.fn(() => {
    const result = { result: database, onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined };
    queueMicrotask(() => result.onsuccess?.());
    return result;
  });
  vi.stubGlobal('indexedDB', { open });
  return { open, store, stored, transaction, database };
}
async function tick(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}
const id = toHostModelDirectoryId({ raw: 'registration-1' });
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('host model handles database', () => {
  it('stores only the directory handle under its registration ID and waits for commit', async () => {
    const harness = databaseHarness({ value: undefined });
    const handle = { kind: 'directory', getDirectoryHandle() {}, async queryPermission() {
      return 'granted';
    }, async requestPermission() {
      return 'granted';
    } };
    const settled = vi.fn();
    const operation = hostModelHandles.put({ id, handle: handle as unknown as FileSystemDirectoryHandle }).then(settled);
    await tick();
    expect(harness.open).toHaveBeenCalledWith('naidan-experimental-model-handles', 1);
    expect(harness.transaction.objectStore).toHaveBeenCalledWith('handles');
    expect(harness.store.put).toHaveBeenCalledWith(handle, 'registration-1');
    expect(settled).not.toHaveBeenCalled();
    harness.transaction.oncomplete?.(); await operation;
    expect(settled).toHaveBeenCalledOnce();
    expect(harness.database.close).toHaveBeenCalledOnce();
  });

  it('rejects an aborted transaction instead of treating its request as saved', async () => {
    const harness = databaseHarness({ value: undefined });
    const operation = hostModelHandles.delete({ id });
    const rejected = expect(operation).rejects.toThrow('Commit failed');
    await tick();
    harness.transaction.error = new DOMException('Commit failed', 'AbortError');
    harness.transaction.onabort?.();
    await rejected;
    expect(harness.database.close).toHaveBeenCalledOnce();
  });

  it('returns undefined only for a missing record and rejects malformed stored values', async () => {
    const missing = databaseHarness({ value: undefined });
    const read = hostModelHandles.get({ id }); await tick(); missing.transaction.oncomplete?.();
    expect(await read).toBeUndefined();
    const malformed = databaseHarness({ value: { name: 'not a handle' } });
    const invalid = hostModelHandles.get({ id });
    const rejected = expect(invalid).rejects.toThrow();
    await tick(); malformed.transaction.oncomplete?.(); await rejected;
  });

  it('deletes only the IDB record without invoking any filesystem deletion', async () => {
    const handle = { remove: vi.fn(), removeEntry: vi.fn() };
    const harness = databaseHarness({ value: handle });
    const removal = hostModelHandles.delete({ id }); await tick(); harness.transaction.oncomplete?.(); await removal;
    expect(harness.store.delete).toHaveBeenCalledWith('registration-1');
    expect(handle.remove).not.toHaveBeenCalled(); expect(handle.removeEntry).not.toHaveBeenCalled();
  });
});
