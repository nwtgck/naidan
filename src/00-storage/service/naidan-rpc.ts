import { rpcConnectionFromDto, rpcConnectionToDto } from '@/00-storage/mapper/naidan-rpc';
import { rpcIdentitySchema, rpcTransportSchema } from '@/00-storage/00-dto/naidan-rpc.dto';
import type { NaidanRpcConnection, NaidanRpcIdentity, NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { idToRaw } from '@/01-models/ids';
import type { NaidanRpcConnectionId } from '@/01-models/ids';

const databaseName = 'naidan-peer-rpc';
const connectionsStore = 'connections', identityStore = 'identity';
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    let abandoned = false;
    request.onupgradeneeded = () => {
      for (const name of [connectionsStore, identityStore]) {
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
      const transaction = database.transaction([connectionsStore, identityStore], mode);
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
        run({ transaction, result: ({ value }) => {
          outcome = { value };
        }, fail });
      } catch (error) {
        fail({ error });
      }
    });
  } finally {
    database.close();
  }
}

/** Public persistence boundary; no RPC runtime or network operations occur here. */
export const naidanRpcStorage = {
  async readIdentity(): Promise<NaidanRpcIdentity | undefined> {
    return transact({ mode: 'readonly', run: ({ transaction, result, fail }) => {
      const request = transaction.objectStore(identityStore).get('self');
      request.onsuccess = () => {
        try {
          result({ value: request.result === undefined ? undefined : rpcIdentitySchema.parse(request.result) });
        } catch (error) {
          fail({ error });
        }
      };
    } });
  },
  async list(): Promise<NaidanRpcConnection[]> {
    return transact({ mode: 'readonly', run: ({ transaction, result, fail }) => {
      const request = transaction.objectStore(connectionsStore).getAll();
      request.onsuccess = () => {
        try {
          result({ value: request.result.map(value => rpcConnectionFromDto({ value })) });
        } catch (error) {
          fail({ error });
        }
      };
    } });
  },
  /** Identity and remembered connection publish atomically. An existing local
   * identity is insert-once: another tab must not silently replace it. */
  async remember({ connection, identity }: { connection: NaidanRpcConnection, identity: NaidanRpcIdentity }): Promise<void> {
    const dto = rpcConnectionToDto({ connection }), key = rpcIdentitySchema.parse(identity);
    if (dto.revision !== 0 || dto.localPublicKey !== key.publicKey) throw new Error('Invalid new RPC connection');
    return transact({ mode: 'readwrite', run: ({ transaction, result, fail }) => {
      const identities = transaction.objectStore(identityStore), connections = transaction.objectStore(connectionsStore);
      const request = identities.get('self');
      request.onsuccess = () => {
        try {
          if (request.result !== undefined && rpcIdentitySchema.parse(request.result).publicKey !== key.publicKey) throw new Error('The local RPC identity changed');
          if (request.result === undefined) identities.add(key, 'self');
          connections.add(dto, dto.id);
          result({ value: undefined });
        } catch (error) {
          fail({ error });
        }
      };
    } });
  },
  async update({ connection, expectedRevision }: { connection: NaidanRpcConnection, expectedRevision: number }): Promise<number> {
    const dto = rpcConnectionToDto({ connection });
    if (dto.revision !== expectedRevision + 1) throw new Error('Invalid RPC connection revision');
    return transact({ mode: 'readwrite', run: ({ transaction, result, fail }) => {
      const store = transaction.objectStore(connectionsStore), request = store.get(dto.id);
      request.onsuccess = () => {
        try {
          const current = rpcConnectionToDto({ connection: rpcConnectionFromDto({ value: request.result }) });
          if (current.revision !== expectedRevision) throw new Error('RPC connection changed in another operation');
          if (current.peerId !== dto.peerId || current.localPublicKey !== dto.localPublicKey) throw new Error('RPC identity changes require a new connection');
          store.put(dto, dto.id); result({ value: dto.revision });
        } catch (error) {
          fail({ error });
        }
      };
    } });
  },
  async remove({ id, expectedRevision }: { id: NaidanRpcConnectionId, expectedRevision: number }): Promise<void> {
    return transact({ mode: 'readwrite', run: ({ transaction, result, fail }) => {
      const store = transaction.objectStore(connectionsStore), raw = idToRaw({ id }), request = store.get(raw);
      request.onsuccess = () => {
        try {
          const current = rpcConnectionFromDto({ value: request.result });
          if (current.revision !== expectedRevision) throw new Error('RPC connection changed in another operation');
          store.delete(raw); result({ value: undefined });
        } catch (error) {
          fail({ error });
        }
      };
    } });
  },
};
export function validateRpcTransport({ value }: { value: unknown }): NaidanRpcTransportSettings {
  return rpcTransportSchema.parse(value);
}
export type NaidanRpcStorage = typeof naidanRpcStorage;
export const TEST_ONLY = {
};
