import { rpcRegistrationFromDto, rpcRegistrationToDto } from '@/00-storage/mapper/naidan-rpc';
import { ExperimentalNaidanRpcTransportSchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';
import type { NaidanRpcRegistration, NaidanRpcIdentity, NaidanRpcTransportSettings } from '@/01-models/naidan-rpc';
import { normalizeNaidanRpcTransport } from '@/01-models/naidan-rpc';
import type { NaidanRpcRegistrationId } from '@/01-models/ids';
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
  async remember({ access, registration, identity }: {
    access: NaidanRpcRegistryAccess, registration: NaidanRpcRegistration, identity: NaidanRpcIdentity,
  }): Promise<NaidanRpcRegistryAccess> {
    const normalized = rpcRegistrationFromDto({ value: rpcRegistrationToDto({ registration }) });
    if (normalized.revision !== 0 || normalized.localPublicKey !== identity.publicKey) throw new Error('Invalid new RPC registration');
    switch (access.persistence) {
    case 'durable': break;
    case 'session': throw new Error('Remembering RPC registrations requires persistent storage');
    default: { const exhaustive: never = access.persistence; throw new Error(String(exhaustive)); }
    }
    return storageService.updateNaidanRpcRegistry({
      access,
      updater: async ({ registrations }) => {
        if (registrations.some(current => current.id === normalized.id)) throw new Error('The RPC registration already exists');
        if (registrations.length >= 32) throw new Error('Too many RPC registration records');
        // Commit the nonextractable key first. JSON publication is the commit
        // point for remembered trust; a failed write never rolls the key back.
        await rememberRpcIdentity({ identity });
        return [...registrations, normalized];
      },
    });
  },
  async update({ access, registration, expectedRevision }: {
    access: NaidanRpcRegistryAccess, registration: NaidanRpcRegistration, expectedRevision: number,
  }): Promise<number> {
    const normalized = rpcRegistrationFromDto({ value: rpcRegistrationToDto({ registration }) });
    if (normalized.revision !== expectedRevision + 1) throw new Error('Invalid RPC registration revision');
    await storageService.updateNaidanRpcRegistry({
      access,
      updater: async ({ registrations }) => {
        const current = registrations.find(current => current.id === normalized.id);
        if (!current || current.revision !== expectedRevision) throw new Error('RPC registration changed in another operation');
        if (current.peerPublicKey !== normalized.peerPublicKey || current.localPublicKey !== normalized.localPublicKey) throw new Error('RPC identity changes require a new registration');
        return registrations.map(current => current.id === normalized.id ? normalized : current);
      },
    });
    return normalized.revision;
  },
  async remove({ access, id, expectedRevision }: {
    access: NaidanRpcRegistryAccess, id: NaidanRpcRegistrationId, expectedRevision: number,
  }): Promise<void> {
    await storageService.updateNaidanRpcRegistry({
      access,
      updater: async ({ registrations }) => {
        const current = registrations.find(current => current.id === id);
        if (!current || current.revision !== expectedRevision) throw new Error('RPC registration changed in another operation');
        return registrations.filter(current => current.id !== id);
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
