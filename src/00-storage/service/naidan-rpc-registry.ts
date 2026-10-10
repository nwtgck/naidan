import { nanoid } from 'nanoid';
import type { NaidanRpcRegistration } from '@/01-models/naidan-rpc';
import type { NaidanRpcRegistryId } from '@/01-models/ids';
import { idToRaw, toNaidanRpcRegistryId } from '@/01-models/ids';
import { ExperimentalNaidanRpcRegistrySchemaDto } from '@/00-storage/00-dto/experimental-naidan-rpc.dto';
import { rpcRegistrationFromDto, rpcRegistrationToDto } from '@/00-storage/mapper/naidan-rpc';
import type { IStorageProvider } from './interface';

/** A session-local reference to the provider and registry that were read.
 * Registration revisions alone cannot detect a cleared or replaced registry. */
export type NaidanRpcRegistryAccess = {
  readonly providerGeneration: number,
  readonly registryId: NaidanRpcRegistryId | undefined,
  readonly persistence: 'durable' | 'session',
};
export type NaidanRpcRegistrySnapshot = {
  access: NaidanRpcRegistryAccess,
  registrations: NaidanRpcRegistration[],
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
  if (value === undefined) return { access: { providerGeneration, persistence, registryId: undefined }, registrations: [] };
  const { version: _version, id, registrations, ...rest } = ExperimentalNaidanRpcRegistrySchemaDto.parse(value);
  rest satisfies Record<PropertyKey, never>;
  validateRegistry({ id, registrations });
  return {
    access: { providerGeneration, persistence, registryId: toNaidanRpcRegistryId({ raw: id }) },
    registrations: registrations.map(value => rpcRegistrationFromDto({ value })),
  };
}

/** The caller holds the common storage lock, including provider switching and
 * clearing. Only the selected record is changed in the latest registry. */
export async function writeNaidanRpcRegistry({ provider, current, registrations }: {
  provider: IStorageProvider, current: NaidanRpcRegistrySnapshot, registrations: readonly NaidanRpcRegistration[],
}): Promise<NaidanRpcRegistryAccess> {
  const id = current.access.registryId ?? toNaidanRpcRegistryId({ raw: nanoid() });
  const registry = ExperimentalNaidanRpcRegistrySchemaDto.parse({ version: 1, id: idToRaw({ id }), registrations: registrations.map(registration => rpcRegistrationToDto({ registration })) });
  validateRegistry({ id: registry.id, registrations: registry.registrations });
  await provider.saveNaidanRpcRegistry({ registry });
  // Retain the registry ID when its last registration is removed. A recreated
  // document after clearAll must not share authority with the old document.
  return { ...current.access, registryId: id };
}

function validateRegistry({ id, registrations }: { id: string; registrations: readonly { id: string }[] }): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid RPC registry identity');
  if (registrations.length > 32) throw new Error('RPC registry capacity exceeded');
  if (new Set(registrations.map(registration => registration.id)).size !== registrations.length) throw new Error('Duplicate RPC registration');
}

export const TEST_ONLY = {
};
