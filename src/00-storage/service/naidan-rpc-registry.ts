import { nanoid } from 'nanoid';
import type { NaidanRpcRegistration } from '@/01-models/naidan-rpc';
import type { NaidanRpcRegistryId } from '@/01-models/ids';
import { toNaidanRpcRegistryId } from '@/01-models/ids';
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
  if (value === undefined) {
    return { access: { providerGeneration, persistence, registryId: undefined }, registrations: [] };
  }
  const { id, registrations } = value;
  return {
    access: { providerGeneration, persistence, registryId: id },
    registrations,
  };
}

/** The caller holds the common storage lock, including provider switching and
 * clearing. Only the selected record is changed in the latest registry. */
export async function writeNaidanRpcRegistry({ provider, current, registrations }: {
  provider: IStorageProvider, current: NaidanRpcRegistrySnapshot, registrations: readonly NaidanRpcRegistration[],
}): Promise<NaidanRpcRegistryAccess> {
  const id = current.access.registryId ?? toNaidanRpcRegistryId({ raw: nanoid() });
  await provider.saveNaidanRpcRegistry({ registry: { id, registrations } });
  // Retain the registry ID when its last registration is removed. A recreated
  // document after clearAll must not share authority with the old document.
  return { ...current.access, registryId: id };
}

export const TEST_ONLY = {
};
