import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { naidanRpcStorage } from './naidan-rpc';
import type { NaidanRpcConnection, NaidanRpcIdentity } from '@/01-models/naidan-rpc';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';

/** Transaction fixture, not a browser IndexedDB implementation. A request may
 * succeed while commit later fails; writes are made visible only on commit. */
function database() {
  const stores = new Map<string, Map<string, unknown>>([['connections', new Map()], ['identity', new Map()]]);
  let rejectCommit = false;
  const closes = vi.fn(), requests: string[] = [];
  function transaction() {
    const draft = new Map([...stores].map(([name, entries]) => [name, new Map(entries)]));
    let pending = 0, aborted = false, dirty = false, completed = false;
    const tx = {
      oncomplete: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined,
      abort() {
        if (aborted) throw new Error('Already aborted'); aborted = true; queueMicrotask(() => tx.onabort?.());
      },
      objectStore(name: string) {
        const entries = draft.get(name)!;
        function task({ run, write }: { run(): unknown, write: boolean }) {
          pending++; dirty ||= write;
          const request = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined };
          queueMicrotask(() => {
            if (aborted) return;
            try {
              request.result = run(); request.onsuccess?.();
            } catch {
              tx.abort(); return;
            } finally {
              pending--;
            }
            queueMicrotask(() => {
              if (pending || aborted || completed) return;
              if (rejectCommit && dirty) {
                rejectCommit = false; tx.abort(); return;
              }
              completed = true;
              for (const [key, value] of draft) stores.set(key, value);
              tx.oncomplete?.();
            });
          });
          return request;
        }
        return {
          get(key: string) {
            requests.push(`${name}:get`); return task({ run: () => entries.get(key), write: false });
          },
          getAll() {
            requests.push(`${name}:getAll`); return task({ run: () => [...entries.values()], write: false });
          },
          add(value: unknown, key: string) {
            requests.push(`${name}:add`); return task({ run: () => {
              if (entries.has(key)) throw new Error('ConstraintError'); entries.set(key, structuredClone(value)); return key;
            }, write: true });
          },
          put(value: unknown, key: string) {
            requests.push(`${name}:put`); return task({ run: () => {
              entries.set(key, structuredClone(value)); return key;
            }, write: true });
          },
          delete(key: string) {
            requests.push(`${name}:delete`); return task({ run: () => entries.delete(key), write: true });
          },
        };
      },
    };
    return tx;
  }
  vi.stubGlobal('indexedDB', { open() {
    const result = { transaction, close: closes, onversionchange: undefined };
    const request = { result, onsuccess: undefined as (() => void) | undefined };
    queueMicrotask(() => request.onsuccess?.()); return request;
  } });
  return { stores, requests, closes, failNextCommit() {
    rejectCommit = true;
  } };
}
let identity: NaidanRpcIdentity;
const connection: NaidanRpcConnection = { id: toNaidanRpcConnectionId({ raw: 'connection-1' }), peerId: toNaidanRpcPeerId({ raw: 'B'.repeat(43) }),
  localPublicKey: 'A'.repeat(43), label: 'Peer', revision: 0, allowedMethods: ['generateChat'], transport: { type: 'naidan_piping_duplex', serverUrl: 'https://relay.example', headers: [] } };
beforeEach(async () => {
  const key = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  identity = { privateKey: key.privateKey, publicKey: connection.localPublicKey };
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Persistence must not connect'));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it('reading empty storage neither installs an identity nor connects', async () => {
  const db = database(); expect(await naidanRpcStorage.readIdentity()).toBeUndefined(); expect(await naidanRpcStorage.list()).toEqual([]);
  expect(db.requests).toEqual(['identity:get', 'connections:getAll']); expect(fetch).not.toHaveBeenCalled(); expect(db.closes).toHaveBeenCalledTimes(2);
});
it('commits identity and connection together and preserves a nonextractable key', async () => {
  database(); await naidanRpcStorage.remember({ connection, identity });
  expect(await naidanRpcStorage.list()).toEqual([connection]); expect((await naidanRpcStorage.readIdentity())?.privateKey.extractable).toBe(false);
});
it('does not report success when a successful put is followed by commit failure', async () => {
  const db = database(); await naidanRpcStorage.remember({ connection, identity }); db.failNextCommit();
  await expect(naidanRpcStorage.update({ connection: { ...connection, revision: 1, allowedMethods: [] }, expectedRevision: 0 })).rejects.toThrow('aborted');
  expect((await naidanRpcStorage.list())[0]?.allowedMethods).toEqual(['generateChat']);
});
it('refuses stale revisions and never overwrites a concurrent update', async () => {
  database(); await naidanRpcStorage.remember({ connection, identity });
  await naidanRpcStorage.update({ connection: { ...connection, revision: 1, label: 'new' }, expectedRevision: 0 });
  await expect(naidanRpcStorage.update({ connection: { ...connection, revision: 1, label: 'stale' }, expectedRevision: 0 })).rejects.toThrow('another operation');
  expect((await naidanRpcStorage.list())[0]?.label).toBe('new');
});
it('cannot substitute the remembered peer under the same connection ID', async () => {
  database(); await naidanRpcStorage.remember({ connection, identity });
  await expect(naidanRpcStorage.update({ connection: { ...connection, peerId: toNaidanRpcPeerId({ raw: 'C'.repeat(43) }), revision: 1 }, expectedRevision: 0 })).rejects.toThrow('identity changes');
});
it('cannot replace the local key while remembering another peer', async () => {
  database(); await naidanRpcStorage.remember({ connection, identity });
  const alternate = { ...identity, publicKey: 'D'.repeat(43) };
  await expect(naidanRpcStorage.remember({ connection: { ...connection, id: toNaidanRpcConnectionId({ raw: 'connection-2' }), localPublicKey: alternate.publicKey }, identity: alternate })).rejects.toThrow('identity changed');
  expect(await naidanRpcStorage.list()).toHaveLength(1);
});
it('deletes only the expected revision and keeps the local identity', async () => {
  database(); await naidanRpcStorage.remember({ connection, identity });
  await expect(naidanRpcStorage.remove({ id: connection.id, expectedRevision: 9 })).rejects.toThrow();
  await naidanRpcStorage.remove({ id: connection.id, expectedRevision: 0 });
  expect(await naidanRpcStorage.list()).toEqual([]); expect(await naidanRpcStorage.readIdentity()).toBeDefined();
});
