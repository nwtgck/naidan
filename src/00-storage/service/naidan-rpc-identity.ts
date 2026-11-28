import { openIndexedDb } from './indexed-db';
import { indexedDbFormat } from '@/00-format/01-layout/layout';
import type { IndexedDbLocation, IndexedDbRecordTransaction } from '@/00-format/indexed-db-records';

function openDatabase({ location }: { location: IndexedDbLocation }): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = openIndexedDb({ location });
    let abandoned = false;
    request.onblocked = () => {
      abandoned = true;
      reject(new Error('Naidan RPC storage is blocked by another tab'));
    };
    request.onerror = () => reject(new Error('Naidan RPC storage could not be opened'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (abandoned) {
        database.close();
      } else {
        resolve(database);
      }
    };
  });
}

const transact: IndexedDbRecordTransaction = async ({ location, key, mode, use }) => {
  const database = await openDatabase({ location });
  try {
    return await new Promise<ReturnType<typeof use>>((resolve, reject) => {
      const transaction = database.transaction([location.store.name], mode);
      let outcome: { value: ReturnType<typeof use> } | undefined;
      let failure: unknown;
      const fail = ({ error }: { error: unknown }) => {
        failure = error;
        try {
          transaction.abort();
        } catch {
          reject(error);
        }
      };
      transaction.oncomplete = () => outcome ? resolve(outcome.value) : reject(new Error('Missing RPC storage result'));
      transaction.onabort = () => reject(failure ?? new Error('Naidan RPC storage transaction aborted'));
      transaction.onerror = () => { /* onabort reports final failure; a request success is not a commit. */ };
      try {
        const store = transaction.objectStore(location.store.name);
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            // A following add must start in this native callback to keep the transaction active.
            outcome = {
              value: use({
                value: request.result,
                add: ({ value }) => {
                  store.add(value, key);
                },
              }),
            };
          } catch (error) {
            fail({ error });
          }
        };
      } catch (error) {
        fail({ error });
      }
    });
  } finally {
    database.close();
  }
};

/** Insert once. A registry save failure leaves this committed key available for
 * retry; no registry, labels, permissions or session state belong in IndexedDB. */
export const { read: readRpcIdentity, remember: rememberRpcIdentity } = indexedDbFormat.rpcIdentity.bind({ transact });

export const TEST_ONLY = {
};
