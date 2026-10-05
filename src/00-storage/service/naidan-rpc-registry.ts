import { nanoid } from 'nanoid';
import type { NaidanRpcConnection } from '@/01-models/naidan-rpc';
import type { NaidanRpcRegistryId } from '@/01-models/ids';
import { idToRaw, toNaidanRpcRegistryId } from '@/01-models/ids';
import { ExperimentalNaidanRpcRegistrySchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';
import { rpcConnectionFromDto, rpcConnectionToDto } from '@/00-storage/mapper/naidan-rpc';
import type { IStorageProvider } from './interface';

/** A session-local reference to the provider and registry that were read.
 * Connection revisions alone cannot detect a cleared or replaced registry. */
export type NaidanRpcRegistryAccess = {
  readonly providerGeneration: number,
  readonly registryId: NaidanRpcRegistryId | undefined,
  readonly persistence: 'durable' | 'session',
};
export type NaidanRpcRegistrySnapshot = {
  access: NaidanRpcRegistryAccess,
  connections: NaidanRpcConnection[],
};
export function sameNaidanRpcRegistry({ left, right }: { left: NaidanRpcRegistryAccess, right: NaidanRpcRegistryAccess }): boolean {
  const { providerGeneration: leftGeneration, registryId: leftId, persistence: leftPersistence, ...leftRest } = left;
  leftRest satisfies Record<PropertyKey, never>;
  const { providerGeneration: rightGeneration, registryId: rightId, persistence: rightPersistence, ...rightRest } = right;
  rightRest satisfies Record<PropertyKey, never>;
  return leftGeneration === rightGeneration && leftId === rightId && leftPersistence === rightPersistence;
}
export async function readNaidanRpcRegistry({ provider, providerGeneration, persistence }: {
  provider: IStorageProvider, providerGeneration: number, persistence: NaidanRpcRegistryAccess['persistence'],
}): Promise<NaidanRpcRegistrySnapshot> {
  const value = await provider.loadNaidanRpcRegistry();
  if (value === undefined) return { access: { providerGeneration, persistence, registryId: undefined }, connections: [] };
  const { version: _version, id, connections, ...rest } = ExperimentalNaidanRpcRegistrySchemaDto.parse(value);
  rest satisfies Record<PropertyKey, never>;
  return { access: { providerGeneration, persistence, registryId: toNaidanRpcRegistryId({ raw: id }) },
    connections: connections.map(value => rpcConnectionFromDto({ value })) };
}
/** The caller holds the common storage lock, including provider switching and
 * clearing. Only the selected record is changed in the latest registry. */
export async function writeNaidanRpcRegistry({ provider, current, connections }: {
  provider: IStorageProvider, current: NaidanRpcRegistrySnapshot, connections: readonly NaidanRpcConnection[],
}): Promise<NaidanRpcRegistryAccess> {
  const id = current.access.registryId ?? toNaidanRpcRegistryId({ raw: nanoid() });
  const registry = ExperimentalNaidanRpcRegistrySchemaDto.parse({ version: 1, id: idToRaw({ id }), connections: connections.map(connection => rpcConnectionToDto({ connection })) });
  await provider.saveNaidanRpcRegistry({ registry });
  // Retain the registry ID when its last connection is removed. A recreated
  // document after clearAll must not share authority with the old document.
  return { ...current.access, registryId: id };
}
export const TEST_ONLY = {
};
