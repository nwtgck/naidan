import { ExperimentalNaidanRpcIdentitySchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';
import type { NaidanRpcIdentity } from '@/01-models/naidan-rpc';

const databaseName = 'naidan-experimental-rpc-identity';
const identityStore = 'identity';
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let abandoned = false;
    request.onupgradeneeded = () => {
      for (const name of [identityStore]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onblocked = () => {
      abandoned = true; reject(new Error('Naidan RPC storage is blocked by another tab'));
    };
    request.onerror = () => reject(new Error('Naidan RPC storage could not be opened'));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (abandoned) database.close(); else resolve(database);
    };
  });
}
async function transact<T>({ mode, run }: {
  mode: IDBTransactionMode,
  run({ transaction, result, fail }: { transaction: IDBTransaction, result({ value }: { value: T }): void, fail({ error }: { error: unknown }): void }): void,
}): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction([identityStore], mode);
      let outcome: { value: T } | undefined;
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
        run({
          transaction,
          result: ({ value }) => {
          outcome = { value };
        },
          fail,
        });
      } catch (error) {
        fail({ error });
      }
    });
  } finally {
    database.close();
  }
}

export async function readRpcIdentity(): Promise<NaidanRpcIdentity | undefined> {
  return transact({
    mode: 'readonly',
    run: ({ transaction, result, fail }) => {
    const request = transaction.objectStore(identityStore).get('self');
    request.onsuccess = () => {
      try {
        result({ value: request.result === undefined ? undefined : ExperimentalNaidanRpcIdentitySchemaDto.parse(request.result) });
      } catch (error) {
        fail({ error });
      }
    };
  },
  });
}
/** Insert once. A registry save failure leaves this committed key available for
 * retry; no registry, labels, permissions or session state belong in IndexedDB. */
export async function rememberRpcIdentity({ identity }: { identity: NaidanRpcIdentity }): Promise<void> {
  const key = ExperimentalNaidanRpcIdentitySchemaDto.parse(identity);
  return transact({
    mode: 'readwrite',
    run: ({ transaction, result, fail }) => {
    const store = transaction.objectStore(identityStore), request = store.get('self');
    request.onsuccess = () => {
      try {
        if (request.result === undefined) store.add(key, 'self');
        else if (ExperimentalNaidanRpcIdentitySchemaDto.parse(request.result).publicKey !== key.publicKey) throw new Error('The local RPC identity changed');
        result({ value: undefined });
      } catch (error) {
        fail({ error });
      }
    };
  },
  });
}
export const TEST_ONLY = {
};
