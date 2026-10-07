import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { naidanRpcStorage } from './naidan-rpc';
import { storageService } from './index';
import { LocalStorageProvider } from './local-storage';
import { MemoryStorageProvider } from './memory-storage';
import type { NaidanRpcConnection, NaidanRpcIdentity } from '@/01-models/naidan-rpc';
import { toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';

/** Transaction fixture, not a browser IndexedDB implementation. A request may
 * succeed while commit later fails; writes are made visible only on commit. */
function database() {
  const stores = new Map<string, Map<string, unknown>>([['identity', new Map()]]);
  let rejectCommit = false;
  const closes = vi.fn(), requests: string[] = [], scopes: string[][] = [], names: string[] = [];
  function transaction(scope: string[]) {
    scopes.push(scope);
    const draft = new Map([...stores].map(([name, entries]) => [name, new Map(entries)]));
    let pending = 0, aborted = false, dirty = false, completed = false;
    const tx = {
      oncomplete: undefined as (() => void) | undefined,
      onabort: undefined as (() => void) | undefined,
      onerror: undefined as (() => void) | undefined,
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
            requests.push(`${name}:add`); return task({
              run: () => {
              if (entries.has(key)) throw new Error('ConstraintError'); entries.set(key, structuredClone(value)); return key;
            },
              write: true,
            });
          },
          put(value: unknown, key: string) {
            requests.push(`${name}:put`); return task({
              run: () => {
              entries.set(key, structuredClone(value)); return key;
            },
              write: true,
            });
          },
          delete(key: string) {
            requests.push(`${name}:delete`); return task({ run: () => entries.delete(key), write: true });
          },
        };
      },
    };
    return tx;
  }
  vi.stubGlobal('indexedDB', {
    open(name: string) {
    names.push(name);
    const result = { transaction, close: closes, onversionchange: undefined };
    const request = { result, onsuccess: undefined as (() => void) | undefined };
    queueMicrotask(() => request.onsuccess?.()); return request;
  },
  });
  return {
    stores,
    requests,
    closes,
    scopes,
    names,
    failNextCommit() {
    rejectCommit = true;
  },
  };
}
let identity: NaidanRpcIdentity;
const connection: NaidanRpcConnection = {
  id: toNaidanRpcConnectionId({ raw: 'connection-1' }),
  peerId: toNaidanRpcPeerId({ raw: 'B'.repeat(43) }),
  autoConnect: 'disabled',
  localPublicKey: 'A'.repeat(43),
  label: 'Peer',
  revision: 0,
  allowedMethods: ['generateChat'],
  transport: { type: 'naidan_piping_duplex', serverUrl: 'https://piping.example', headers: [] },
};
beforeEach(async () => {
  localStorage.clear();
  let previous = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
    request: vi.fn((_name: string, run: () => Promise<unknown>) => {
    const result = previous.then(run); previous = result.then(() => {}, () => {}); return result;
  }),
  },
  });
  await storageService.init({ type: 'local' });
  const key = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  identity = { privateKey: key.privateKey, publicKey: connection.localPublicKey };
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Persistence must not connect'));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function remember({ next }: { next: NaidanRpcConnection }) {
  const { access } = await naidanRpcStorage.list();
  return naidanRpcStorage.remember({ access, connection: next, identity });
}
it('reading empty storage neither installs an identity nor connects', async () => {
  const db = database(); expect(await naidanRpcStorage.readIdentity()).toBeUndefined();
  expect((await naidanRpcStorage.list()).connections).toEqual([]);
  expect(localStorage.length).toBe(0); expect(db.requests).toEqual(['identity:get']);
  expect(fetch).not.toHaveBeenCalled(); expect(db.closes).toHaveBeenCalledOnce();
});
it('keeps only the nonextractable identity in IndexedDB and writes connections through the provider', async () => {
  const db = database(); await remember({ next: connection });
  expect((await naidanRpcStorage.list()).connections).toEqual([connection]);
  expect((await naidanRpcStorage.readIdentity())?.privateKey.extractable).toBe(false);
  expect(db.scopes.every(scope => scope.length === 1 && scope[0] === 'identity')).toBe(true);
  expect(new Set(db.names)).toEqual(new Set(['naidan-experimental-rpc-identity']));
  expect(db.stores.get('identity')?.size).toBe(1);
  const stored = await new LocalStorageProvider().loadNaidanRpcRegistry();
  expect(stored?.connections[0]?.transport).toEqual(connection.transport);
  expect(JSON.stringify(stored)).not.toContain('privateKey'); expect(fetch).not.toHaveBeenCalled();
});
it('does not publish a connection when the identity transaction fails at commit', async () => {
  const db = database(); db.failNextCommit();
  await expect(remember({ next: connection })).rejects.toThrow('aborted');
  expect((await naidanRpcStorage.list()).connections).toEqual([]);
  expect(await naidanRpcStorage.readIdentity()).toBeUndefined();
});
it('leaves a committed key available for retry when the registry save fails', async () => {
  database(); vi.spyOn(LocalStorageProvider.prototype, 'saveNaidanRpcRegistry').mockRejectedValueOnce(new Error('quota'));
  await expect(remember({ next: connection })).rejects.toThrow('quota');
  expect((await naidanRpcStorage.list()).connections).toEqual([]);
  const key = await naidanRpcStorage.readIdentity(); expect(key?.privateKey.extractable).toBe(false);
  await remember({ next: connection });
  expect((await naidanRpcStorage.readIdentity())?.publicKey).toBe(key?.publicKey);
  expect((await naidanRpcStorage.list()).connections).toEqual([connection]);
});
it('does not report success or replace grants when the provider write fails', async () => {
  database(); const access = await remember({ next: connection });
  vi.spyOn(LocalStorageProvider.prototype, 'saveNaidanRpcRegistry').mockRejectedValueOnce(new Error('quota'));
  await expect(naidanRpcStorage.update({ access, connection: { ...connection, revision: 1, allowedMethods: [] }, expectedRevision: 0 })).rejects.toThrow('quota');
  expect((await naidanRpcStorage.list()).connections[0]?.allowedMethods).toEqual(['generateChat']);
});
it('refuses stale revisions and never overwrites a concurrent update', async () => {
  database(); const access = await remember({ next: connection });
  await naidanRpcStorage.update({ access, connection: { ...connection, revision: 1, label: 'new' }, expectedRevision: 0 });
  await expect(naidanRpcStorage.update({ access, connection: { ...connection, revision: 1, label: 'stale' }, expectedRevision: 0 })).rejects.toThrow('another operation');
  expect((await naidanRpcStorage.list()).connections[0]?.label).toBe('new');
});
it('preserves independent record updates made from the same registry snapshot', async () => {
  database(); const access = await remember({ next: connection });
  const other = { ...connection, id: toNaidanRpcConnectionId({ raw: 'connection-2' }) };
  await remember({ next: other });
  await Promise.all([
    naidanRpcStorage.update({ access, connection: { ...connection, revision: 1, label: 'first' }, expectedRevision: 0 }),
    naidanRpcStorage.update({ access, connection: { ...other, revision: 1, label: 'second' }, expectedRevision: 0 }),
  ]);
  expect((await naidanRpcStorage.list()).connections.map(connection => connection.label)).toEqual(['first', 'second']);
});
it('cannot substitute the remembered peer under the same connection ID', async () => {
  database(); const access = await remember({ next: connection });
  await expect(naidanRpcStorage.update({ access, connection: { ...connection, peerId: toNaidanRpcPeerId({ raw: 'C'.repeat(43) }), revision: 1 }, expectedRevision: 0 })).rejects.toThrow('identity changes');
});
it('cannot replace the local key while remembering another peer', async () => {
  database(); const access = await remember({ next: connection });
  const alternate = { ...identity, publicKey: 'D'.repeat(43) };
  await expect(naidanRpcStorage.remember({ access, connection: { ...connection, id: toNaidanRpcConnectionId({ raw: 'connection-2' }), localPublicKey: alternate.publicKey }, identity: alternate })).rejects.toThrow('identity changed');
  expect((await naidanRpcStorage.list()).connections).toHaveLength(1);
});
it('deletes only the expected revision and keeps the local identity and registry ID', async () => {
  database(); const access = await remember({ next: connection });
  await expect(naidanRpcStorage.remove({ access, id: connection.id, expectedRevision: 9 })).rejects.toThrow();
  await naidanRpcStorage.remove({ access, id: connection.id, expectedRevision: 0 });
  expect((await naidanRpcStorage.list()).connections).toEqual([]);
  expect((await naidanRpcStorage.list()).access.registryId).toBe(access.registryId);
  expect(await naidanRpcStorage.readIdentity()).toBeDefined();
});
it('rejects an old snapshot after clearing and recreating the same connection revision', async () => {
  database(); const access = await remember({ next: connection });
  await storageService.clearAll(); await remember({ next: connection });
  await expect(naidanRpcStorage.update({ access, connection: { ...connection, label: 'stale', revision: 1 }, expectedRevision: 0 })).rejects.toThrow('registry changed');
  expect((await naidanRpcStorage.list()).connections[0]?.label).toBe('Peer');
});
it('copies the registry on provider switches and fences old operations after switching back', async () => {
  database(); const access = await remember({ next: connection });
  await storageService.switchProvider({ type: 'memory' });
  expect((await naidanRpcStorage.list()).connections).toEqual([connection]);
  expect((await naidanRpcStorage.list()).access.persistence).toBe('session');
  await storageService.switchProvider({ type: 'local' });
  await expect(naidanRpcStorage.update({ access, connection: { ...connection, label: 'stale', revision: 1 }, expectedRevision: 0 })).rejects.toThrow('registry changed');
  expect((await naidanRpcStorage.list()).connections).toEqual([connection]);
});
it('rejects unreadable registries instead of treating them as permission to create empty storage', async () => {
  database(); await remember({ next: connection });
  const key = Object.keys(localStorage).find(key => key.endsWith('experimental-naidan-rpc-connections'));
  if (!key) throw new Error('The registry should be stored through local storage');
  localStorage.setItem(key, '{');
  await expect(naidanRpcStorage.list()).rejects.toThrow();
  expect(localStorage.getItem(key)).toBe('{');
});
it('does not install an identity or claim durable trust in memory storage', async () => {
  const db = database(); await storageService.switchProvider({ type: 'memory' });
  await expect(remember({ next: connection })).rejects.toThrow('persistent storage');
  expect(db.requests).toEqual([]); expect((await naidanRpcStorage.list()).connections).toEqual([]);
});
it('requires actual cross-tab locks for durable writes', async () => {
  const db = database(); const { access } = await naidanRpcStorage.list();
  vi.stubGlobal('navigator', {});
  await expect(naidanRpcStorage.remember({ access, connection, identity })).rejects.toThrow('Web Locks');
  expect(db.requests).toEqual([]); expect((await naidanRpcStorage.list()).connections).toEqual([]);
});
it('keeps local trust and transport credentials out of general JSON backups', async () => {
  database(); await remember({ next: { ...connection, transport: { ...connection.transport, headers: [{ name: 'Authorization', value: 'private-secret' }] } } });
  const backup = await storageService.dumpWithoutLock();
  expect(JSON.stringify(backup.structure)).not.toContain('private-secret');
  expect(JSON.stringify(backup.structure)).not.toContain('localPublicKey');
});
it('retains the original provider when copying its registry to a new provider fails', async () => {
  database(); const access = await remember({ next: connection });
  vi.spyOn(MemoryStorageProvider.prototype, 'saveNaidanRpcRegistry').mockRejectedValueOnce(new Error('registry copy failed'));
  await expect(storageService.switchProvider({ type: 'memory' })).rejects.toThrow('registry copy failed');
  expect(storageService.getCurrentType()).toBe('local');
  expect((await naidanRpcStorage.list()).access).toEqual(access);
  expect((await naidanRpcStorage.list()).connections).toEqual([connection]);
});
it('notifies registry observers in the writing page without making their errors part of the commit', async () => {
  database(); const observed = vi.fn();
  const unsubscribeThrower = storageService.subscribeNaidanRpcRegistryChanges({
    listener: () => {
    throw new Error('Observer failure');
  },
  });
  const unsubscribe = storageService.subscribeNaidanRpcRegistryChanges({ listener: observed });
  try {
    storageService.notify({ event: { type: 'settings', timestamp: 0 } }); expect(observed).not.toHaveBeenCalled();
    const access = await remember({ next: connection }); expect(observed).toHaveBeenCalledOnce();
    expect((await naidanRpcStorage.list()).connections).toEqual([connection]);
    unsubscribe(); await naidanRpcStorage.remove({ access, id: connection.id, expectedRevision: 0 });
    expect(observed).toHaveBeenCalledOnce();
  } finally {
    unsubscribe(); unsubscribeThrower();
  }
});
