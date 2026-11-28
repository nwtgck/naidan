import { idToRaw, type HostModelDirectoryId, type VolumeId } from '@/01-models/ids';
import type { NaidanRpcIdentity } from '@/01-models/naidan-rpc';

export type IndexedDbLocation = {
  name: string,
  version: number,
  store: { name: string, options: IDBObjectStoreParameters },
};

export type IndexedDbHandleRequests = {
  read({ location, key }: { location: IndexedDbLocation, key: string }): Promise<unknown>,
  write({ location, key, handle }: { location: IndexedDbLocation, key: string, handle(): FileSystemDirectoryHandle }): Promise<unknown>,
  delete({ location, key }: { location: IndexedDbLocation, key: string }): Promise<unknown>,
};

export type HostModelDirectoryHandle = FileSystemDirectoryHandle & {
  // Browser File System Access permission methods are not yet in lib.dom.
  queryPermission({ mode }: { mode: 'read' | 'readwrite' }): Promise<PermissionState>,
  requestPermission({ mode }: { mode: 'read' | 'readwrite' }): Promise<PermissionState>,
};

export function isHostModelDirectoryHandle(value: unknown): value is HostModelDirectoryHandle {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'directory'
    && 'getDirectoryHandle' in value && typeof value.getDirectoryHandle === 'function'
    && 'queryPermission' in value && typeof value.queryPermission === 'function'
    && 'requestPermission' in value && typeof value.requestPermission === 'function';
}

export function hostVolumeHandleRecords({ name, version, store }: {
  name: string, version: number, store: IndexedDbLocation['store'],
}) {
  const location = { name, version, store };
  return {
    name,
    bind({ requests }: { requests: IndexedDbHandleRequests }) {
      return {
        get({ id }: { id: VolumeId }): Promise<FileSystemDirectoryHandle | undefined> {
          // The original format reads browser-cloned handles without an additional guard.
          return requests.read({ location, key: idToRaw({ id }) }) as Promise<FileSystemDirectoryHandle | undefined>;
        },
        async put({ id, handle }: { id: VolumeId, handle: FileSystemDirectoryHandle }): Promise<void> {
          await requests.write({ location, key: idToRaw({ id }), handle: () => handle });
        },
        async delete({ id }: { id: VolumeId }): Promise<void> {
          await requests.delete({ location, key: idToRaw({ id }) });
        },
      };
    },
  };
}

export function hostModelDirectoryRecords({ name, version, store }: {
  name: string, version: number, store: IndexedDbLocation['store'],
}) {
  const location = { name, version, store };
  return {
    bind({ requests, invalidHandleError }: {
      requests: IndexedDbHandleRequests,
      invalidHandleError({ value }: { value: unknown }): Error,
    }) {
      function check({ value }: { value: unknown }): HostModelDirectoryHandle {
        if (!isHostModelDirectoryHandle(value)) {
          throw invalidHandleError({ value });
        }
        return value;
      }
      return {
        async get({ id }: { id: HostModelDirectoryId }): Promise<HostModelDirectoryHandle | undefined> {
          const value = await requests.read({ location, key: idToRaw({ id }) });
          return value === undefined ? undefined : check({ value });
        },
        async put({ id, handle }: { id: HostModelDirectoryId, handle: FileSystemDirectoryHandle }): Promise<void> {
          await requests.write({ location, key: idToRaw({ id }), handle: () => check({ value: handle }) });
        },
        async delete({ id }: { id: HostModelDirectoryId }): Promise<void> {
          await requests.delete({ location, key: idToRaw({ id }) });
        },
      };
    },
  };
}

export type IndexedDbRecordTransaction = <T>({ location, key, mode, use }: {
  location: IndexedDbLocation,
  key: string,
  mode: 'readonly' | 'readwrite',
  use({ value, add }: { value: unknown, add({ value }: { value: unknown }): void }): T,
}) => Promise<T>;

export function rpcIdentityRecord({ name, version, store, key, validateIdentity }: {
  name: string,
  version: number,
  store: IndexedDbLocation['store'],
  key: string,
  validateIdentity({ value }: { value: unknown }): NaidanRpcIdentity,
}) {
  const location = { name, version, store };
  return {
    bind({ transact }: { transact: IndexedDbRecordTransaction }) {
      return {
        async read(): Promise<NaidanRpcIdentity | undefined> {
          return transact({
            location,
            key,
            mode: 'readonly',
            use: ({ value }) => value === undefined ? undefined : validateIdentity({ value }),
          });
        },
        async remember({ identity }: { identity: NaidanRpcIdentity }): Promise<void> {
          const nextIdentity = validateIdentity({ value: identity });
          return transact({
            location,
            key,
            mode: 'readwrite',
            use: ({ value, add }) => {
              if (value === undefined) {
                add({ value: nextIdentity });
              } else if (validateIdentity({ value }).publicKey !== nextIdentity.publicKey) {
                throw new Error('The local RPC identity changed');
              }
            },
          });
        },
      };
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
