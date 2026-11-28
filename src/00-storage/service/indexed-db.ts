import type { IndexedDbHandleRequests, IndexedDbLocation } from '@/00-format/indexed-db-records';

/** Opens the declared database and creates its initial store when required. */
export function openIndexedDb({ location }: { location: IndexedDbLocation }): IDBOpenDBRequest {
  const request = indexedDB.open(location.name, location.version);
  request.onupgradeneeded = () => {
    const database = request.result;
    const { name, options } = location.store;
    if (!database.objectStoreNames.contains(name)) {
      database.createObjectStore(name, options);
    }
  };
  return request;
}

type RunHandleRequest = <T>({ location, mode, start }: {
  location: IndexedDbLocation,
  mode: 'readonly' | 'readwrite',
  start({ store }: { store: IDBObjectStore }): IDBRequest<T>,
}) => Promise<unknown>;

export function indexedDbHandleRequests({ run }: { run: RunHandleRequest }): IndexedDbHandleRequests {
  return {
    read({ location, key }) {
      return run({ location, mode: 'readonly', start: ({ store }) => store.get(key) });
    },
    write({ location, key, handle }) {
      return run({ location, mode: 'readwrite', start: ({ store }) => store.put(handle(), key) });
    },
    delete({ location, key }) {
      return run({ location, mode: 'readwrite', start: ({ store }) => store.delete(key) });
    },
  };
}

/** The original host-volume driver settles on request success. */
export const indexedDbRequestSuccessHandles = indexedDbHandleRequests({
  async run({ location, mode, start }) {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = openIndexedDb({ location });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(location.store.name, mode);
      const request = start({ store: transaction.objectStore(location.store.name) });
      request.onsuccess = () => {
        switch (mode) {
        case 'readonly':
          resolve(request.result);
          return;
        case 'readwrite':
          resolve(undefined);
          return;
        default: {
          const _ex: never = mode;
          throw new Error(`Unhandled IndexedDB mode: ${_ex}`);
        }
        }
      };
      request.onerror = () => reject(request.error);
    });
  },
});

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
