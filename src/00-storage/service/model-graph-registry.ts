import { nanoid } from 'nanoid';
import type { ModelGraphRegistryId } from '@/01-models/ids';
import { toModelGraphRegistryId } from '@/01-models/ids';
import type { ModelGraphRegistration } from '@/01-models/model-graph-registry';
import type { IStorageProvider } from './interface';

export type ModelGraphRegistryAccess = {
  providerGeneration: number,
  registryId: ModelGraphRegistryId | undefined,
  revision: number,
  persistence: 'durable' | 'session',
};
export type ModelGraphRegistrySnapshot = { access: ModelGraphRegistryAccess; registrations: ModelGraphRegistration[] };

export function sameModelGraphRegistry({ left, right }: { left: ModelGraphRegistryAccess, right: ModelGraphRegistryAccess }): boolean {
  const { providerGeneration: lg, registryId: li, revision: lr, persistence: lp, ...lrest } = left;
  const { providerGeneration: rg, registryId: ri, revision: rr, persistence: rp, ...rrest } = right;
  lrest satisfies Record<PropertyKey, never>;
  rrest satisfies Record<PropertyKey, never>;
  return lg === rg && li === ri && lr === rr && lp === rp;
}

export async function readModelGraphRegistry({ provider, providerGeneration, persistence }: {
  provider: IStorageProvider, providerGeneration: number, persistence: ModelGraphRegistryAccess['persistence'],
}): Promise<ModelGraphRegistrySnapshot> {
  const value = await provider.loadModelGraphRegistry();
  if (value === undefined) {
    return { access: { providerGeneration, persistence, registryId: undefined, revision: 0 }, registrations: [] };
  }
  const { id, revision, registrations } = value;
  return { access: { providerGeneration, persistence, registryId: id, revision }, registrations };
}

/** The service holds the same lock as clearing and provider migration. */
export async function writeModelGraphRegistry({ provider, current, registrations }: {
  provider: IStorageProvider, current: ModelGraphRegistrySnapshot, registrations: readonly ModelGraphRegistration[],
}): Promise<ModelGraphRegistryAccess> {
  const id = current.access.registryId ?? toModelGraphRegistryId({ raw: nanoid() });
  const revision = current.access.revision + 1;
  await provider.saveModelGraphRegistry({ registry: { id, revision, registrations } });
  return { ...current.access, registryId: id, revision };
}

export const TEST_ONLY = {
};
