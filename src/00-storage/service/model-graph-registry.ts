import { nanoid } from 'nanoid';
import type { ModelGraphRegistryId } from '@/01-models/ids';
import { idToRaw, toModelGraphRegistryId } from '@/01-models/ids';
import type { ModelGraphRegistration } from '@/01-models/model-graph-registry';
import { validateModelGraphRegistrations } from '@/01-models/model-graph-registry';
import { ExperimentalModelGraphRegistrySchemaDto } from '@/00-storage/00-dto/experimental-model-graph.dto';
import { modelGraphRegistrationFromDto, modelGraphRegistrationToDto } from '@/00-storage/mapper/model-graph';
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
  const { version: _version, id, revision, registrations: stored, ...rest } = ExperimentalModelGraphRegistrySchemaDto.parse(value);
  rest satisfies Record<PropertyKey, never>;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id) || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Invalid model graph registry revision');
  }
  const registrations = stored.map(value => modelGraphRegistrationFromDto({ value }));
  // Do not parse the experimental declaration here. Unsupported source remains
  // editable, and an enabled invalid declaration still blocks its target route.
  validateModelGraphRegistrations({ registrations });
  return { access: { providerGeneration, persistence, registryId: toModelGraphRegistryId({ raw: id }), revision }, registrations };
}

/** The service holds the same lock as clearing and provider migration. */
export async function writeModelGraphRegistry({ provider, current, registrations }: {
  provider: IStorageProvider, current: ModelGraphRegistrySnapshot, registrations: readonly ModelGraphRegistration[],
}): Promise<ModelGraphRegistryAccess> {
  validateModelGraphRegistrations({ registrations });
  const id = current.access.registryId ?? toModelGraphRegistryId({ raw: nanoid() });
  const revision = current.access.revision + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new Error('Model graph revision exhausted');
  }
  const registry = ExperimentalModelGraphRegistrySchemaDto.parse({ version: 1, id: idToRaw({ id }), revision, registrations: registrations.map(registration => modelGraphRegistrationToDto({ registration })) });
  await provider.saveModelGraphRegistry({ registry });
  return { ...current.access, registryId: id, revision };
}

export const TEST_ONLY = {
};
