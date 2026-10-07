import { rpcConnectionFromDto, rpcConnectionToDto } from '@/00-storage/mapper/naidan-rpc';
import { ExperimentalNaidanRpcTransportSchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';
import type { NaidanRpcConnection, NaidanRpcIdentity, NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { normalizeNaidanRpcTransport } from '@/01-models/naidan-rpc';
import type { NaidanRpcConnectionId } from '@/01-models/ids';
import { storageService } from './index';
import { readRpcIdentity, rememberRpcIdentity } from './naidan-rpc-identity';
import type { NaidanRpcRegistryAccess, NaidanRpcRegistrySnapshot } from './naidan-rpc-registry';
export type { NaidanRpcRegistryAccess, NaidanRpcRegistrySnapshot } from './naidan-rpc-registry';
export { sameNaidanRpcRegistry } from './naidan-rpc-registry';

/** Public persistence boundary; no RPC runtime or network operations occur here. */
export const naidanRpcStorage = {
  readIdentity: readRpcIdentity,
  list(): Promise<NaidanRpcRegistrySnapshot> {
    return storageService.loadNaidanRpcRegistry();
  },
  async remember({ access, connection, identity }: {
    access: NaidanRpcRegistryAccess, connection: NaidanRpcConnection, identity: NaidanRpcIdentity,
  }): Promise<NaidanRpcRegistryAccess> {
    const normalized = rpcConnectionFromDto({ value: rpcConnectionToDto({ connection }) });
    if (normalized.revision !== 0 || normalized.localPublicKey !== identity.publicKey) throw new Error('Invalid new RPC connection');
    switch (access.persistence) {
    case 'durable': break;
    case 'session': throw new Error('Remembering RPC connections requires persistent storage');
    default: { const exhaustive: never = access.persistence; throw new Error(String(exhaustive)); }
    }
    return storageService.updateNaidanRpcRegistry({
      access,
      updater: async ({ connections }) => {
        if (connections.some(current => current.id === normalized.id)) throw new Error('The RPC connection already exists');
        if (connections.length >= 32) throw new Error('Too many RPC connection records');
        // Commit the nonextractable key first. JSON publication is the commit
        // point for remembered trust; a failed write never rolls the key back.
        await rememberRpcIdentity({ identity });
        return [...connections, normalized];
      },
    });
  },
  async update({ access, connection, expectedRevision }: {
    access: NaidanRpcRegistryAccess, connection: NaidanRpcConnection, expectedRevision: number,
  }): Promise<number> {
    const normalized = rpcConnectionFromDto({ value: rpcConnectionToDto({ connection }) });
    if (normalized.revision !== expectedRevision + 1) throw new Error('Invalid RPC connection revision');
    await storageService.updateNaidanRpcRegistry({
      access,
      updater: async ({ connections }) => {
        const current = connections.find(current => current.id === normalized.id);
        if (!current || current.revision !== expectedRevision) throw new Error('RPC connection changed in another operation');
        if (current.peerId !== normalized.peerId || current.localPublicKey !== normalized.localPublicKey) throw new Error('RPC identity changes require a new connection');
        return connections.map(current => current.id === normalized.id ? normalized : current);
      },
    });
    return normalized.revision;
  },
  async remove({ access, id, expectedRevision }: {
    access: NaidanRpcRegistryAccess, id: NaidanRpcConnectionId, expectedRevision: number,
  }): Promise<void> {
    await storageService.updateNaidanRpcRegistry({
      access,
      updater: async ({ connections }) => {
        const current = connections.find(current => current.id === id);
        if (!current || current.revision !== expectedRevision) throw new Error('RPC connection changed in another operation');
        return connections.filter(current => current.id !== id);
      },
    });
  },
};
export function validateRpcTransport({ value }: { value: unknown }): NaidanRpcTransportSettings {
  return normalizeNaidanRpcTransport({ transport: ExperimentalNaidanRpcTransportSchemaDto.parse(value) });
}
export type NaidanRpcStorage = typeof naidanRpcStorage;
export const TEST_ONLY = {
};
