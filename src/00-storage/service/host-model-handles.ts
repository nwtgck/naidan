import { z } from 'zod';
import { idToRaw, type HostModelDirectoryId } from '@/01-models/ids';

const databaseName = 'naidan-experimental-model-handles';
const storeName = 'handles';
export type HostModelDirectoryHandle = FileSystemDirectoryHandle & {
  // Browser File System Access permission methods are not yet in lib.dom.
  queryPermission({ mode }: { mode: 'read' | 'readwrite' }): Promise<PermissionState>,
  requestPermission({ mode }: { mode: 'read' | 'readwrite' }): Promise<PermissionState>,
};
const handleSchema = z.custom<HostModelDirectoryHandle>(value =>
  typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'directory'
  && 'getDirectoryHandle' in value && typeof value.getDirectoryHandle === 'function'
  && 'queryPermission' in value && typeof value.queryPermission === 'function'
  && 'requestPermission' in value && typeof value.requestPermission === 'function');

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let rejected = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open linked model handles'));
    request.onblocked = () => {
      rejected = true;
      reject(new Error('Linked model handle storage is blocked by another tab'));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (rejected) database.close();
      else resolve(database);
    };
  });
}

async function transact({ mode, operation }: {
  mode: IDBTransactionMode,
  operation: ({ store }: { store: IDBObjectStore }) => IDBRequest,
}): Promise<unknown> {
  const database = await open();
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation({ store: transaction.objectStore(storeName) });
      // Request success precedes commit. Settings must not reference a handle
      // whose transaction subsequently aborts.
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error('Linked model handle transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('Linked model handle transaction failed'));
    });
  } finally {
    database.close();
  }
}

/** IndexedDB stores only browser-cloneable handles. Registration metadata lives
 * in experimental settings; neither model bytes nor permission state belongs here.
 */
export const hostModelHandles = {
  async get({ id }: { id: HostModelDirectoryId }): Promise<HostModelDirectoryHandle | undefined> {
    const value = await transact({ mode: 'readonly', operation: ({ store }) => store.get(idToRaw({ id })) });
    return value === undefined ? undefined : handleSchema.parse(value);
  },
  async put({ id, handle }: { id: HostModelDirectoryId, handle: FileSystemDirectoryHandle }): Promise<void> {
    await transact({ mode: 'readwrite', operation: ({ store }) => store.put(handleSchema.parse(handle), idToRaw({ id })) });
  },
  async delete({ id }: { id: HostModelDirectoryId }): Promise<void> {
    await transact({ mode: 'readwrite', operation: ({ store }) => store.delete(idToRaw({ id })) });
  },
};

export const TEST_ONLY = {
};
