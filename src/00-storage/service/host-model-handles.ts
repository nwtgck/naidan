import { indexedDbHandleRequests, openIndexedDb } from './indexed-db';
import { z } from 'zod';
import { indexedDbFormat } from '@/00-format/01-layout/layout';
import { isHostModelDirectoryHandle, type HostModelDirectoryHandle, type IndexedDbLocation } from '@/00-format/indexed-db-records';

export type { HostModelDirectoryHandle } from '@/00-format/indexed-db-records';
export const hostModelDirectoryHandleSchema = z.custom<HostModelDirectoryHandle>(isHostModelDirectoryHandle);

function open({ location }: { location: IndexedDbLocation }): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = openIndexedDb({ location });
    let rejected = false;
    request.onerror = () => reject(request.error ?? new Error('Could not open linked model handles'));
    request.onblocked = () => {
      rejected = true;
      reject(new Error('Linked model handle storage is blocked by another tab'));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (rejected) {
        database.close();
      } else {
        resolve(database);
      }
    };
  });
}

const handleRequests = indexedDbHandleRequests({
  async run({ location, mode, start }) {
    const database = await open({ location });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction(location.store.name, mode);
        const request = start({ store: transaction.objectStore(location.store.name) });
        // Request success precedes commit. Settings must not reference a handle
        // whose transaction subsequently aborts.
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error('Linked model handle transaction aborted'));
        transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('Linked model handle transaction failed'));
      });
    } finally {
      database.close();
    }
  },
});

/** IndexedDB stores only browser-cloneable handles. Registration metadata lives
 * in experimental settings; neither model bytes nor permission state belongs here.
 */
export const hostModelHandles = indexedDbFormat.hostModelDirectories.bind({
  requests: handleRequests,
  invalidHandleError: ({ value }) => hostModelDirectoryHandleSchema.safeParse(value).error ?? new Error('Invalid linked model directory handle'),
});

export const TEST_ONLY = {
};
